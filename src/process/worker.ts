/**
 * Bot worker process entry point.
 * Spawned via child_process.fork() with:
 *   argv[2] = rootConfigPath
 *   argv[3] = mainAgentId
 *   argv[4] = subAgentId
 *
 * All Feishu I/O is handled by the Gateway in the main process.
 * This worker receives FEISHU_MESSAGE via IPC and sends outbound messages
 * back to the Gateway via FEISHU_SEND / FEISHU_REACTION_* IPC messages.
 */
import { readFile } from 'fs/promises'
import * as lark from '@larksuiteoapi/node-sdk'
import { RootConfigSchema, type LoadedSubAgentConfig } from '../config/schema.js'
import { loadAgentPrompt } from '../config/agentPrompt.js'
import { initWorkspace } from '../workspace/WorkspaceInit.js'
import { IpcSender } from '../feishu/IpcSender.js'
import { ClaudeClient } from '../llm/ClaudeClient.js'
import { ToolRegistry } from '../tools/ToolRegistry.js'
import { createDelegateTools } from '../tools/feishu/delegate.js'
import { createSendMessageTool } from '../tools/feishu/sendMessage.js'
import { createBitableTools } from '../tools/feishu/bitable.js'
import { createWorkspaceTools } from '../tools/workspace/index.js'
import { createMemoryTools } from '../tools/memory/index.js'
import { createShellTools } from '../tools/shell/index.js'
import { ConversationStore } from '../session/ConversationStore.js'
import { MemoryStore } from '../memory/MemoryStore.js'
import { MessageHandler } from '../feishu/MessageHandler.js'
import { logger, setupErrorLog, setupDiagLog, setProcessLabel } from '../shared/logger.js'
import { BotStatus } from '../shared/types.js'
import type { DownwardMessage, UpwardMessage } from './ipc/types.js'
import { Paths } from '../config/paths.js'

// ─── Bootstrap ──────────────────────────────────────────────────────────────

const rootConfigPath = process.argv[2]
const mainAgentId = process.argv[3]
const subAgentId = process.argv[4]

if (!rootConfigPath || !mainAgentId || !subAgentId) {
  console.error('Usage: worker.ts <rootConfigPath> <mainAgentId> <subAgentId>')
  process.exit(1)
}

const botId = subAgentId

function ipcSend(msg: UpwardMessage): void {
  if (process.send) process.send(msg)
}

async function main(): Promise<void> {
  // Load and validate root config
  let raw: string
  try {
    raw = await readFile(rootConfigPath, 'utf8')
  } catch (err) {
    ipcSend({ type: 'FATAL', botId, code: 'CONFIG_READ_ERROR', message: String(err) })
    process.exit(1)
  }

  const parsed = RootConfigSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')
    ipcSend({ type: 'FATAL', botId, code: 'CONFIG_INVALID', message: issues })
    process.exit(1)
  }

  // Find main agent
  const mainAgent = parsed.data.agents.find((a) => a.id === mainAgentId)
  if (!mainAgent) {
    ipcSend({ type: 'FATAL', botId, code: 'CONFIG_INVALID', message: `Main agent "${mainAgentId}" not found in config` })
    process.exit(1)
  }

  // Determine this bot's config (main agent itself or one of its sub-agents)
  let config: LoadedSubAgentConfig

  if (subAgentId === mainAgentId) {
    config = {
      id: mainAgentId,
      name: mainAgent.name,
      feishu: mainAgent.feishu,
      claude: mainAgent.claude,
      access: mainAgent.access,
      behavior: mainAgent.behavior,
      mainAgentId,
      configPath: rootConfigPath,
    }
  } else {
    const subAgent = mainAgent.subAgents.find((sa) => sa.id === subAgentId)
    if (!subAgent) {
      ipcSend({ type: 'FATAL', botId, code: 'CONFIG_INVALID', message: `Sub-agent "${subAgentId}" not found in main agent "${mainAgentId}"` })
      process.exit(1)
    }
    config = { ...subAgent, mainAgentId, configPath: rootConfigPath }
  }

  // Resolve Claude API key
  const apiKey = config.claude.apiKey ?? process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    ipcSend({ type: 'FATAL', botId, code: 'MISSING_API_KEY', message: 'Claude API key not found in config or ANTHROPIC_API_KEY env' })
    process.exit(1)
  }

  // Initialize full workspace structure (idempotent)
  // - agents/{botId}/: IDENTITY.md, SOUL.md, AGENTS.md, TOOLS.md, memory/
  // - workspace/{botId}/: bot private working directory
  // - workspace/common/: shared workspace with README
  await initWorkspace(botId)

  // Load system prompt from agents/{botId}/ markdown files
  const systemPrompt = await loadAgentPrompt(botId)

  // Initialize components
  const sender = new IpcSender(ipcSend)

  // Memory — markdown daily notes in agents/{botId}/memory/
  // Must initialize before tools so createMemoryTools can reference it
  const memory = new MemoryStore()
  await memory.load(Paths.agentMemoryDir(botId))

  // Track the Feishu messageId of the message currently being processed so
  // delegate_to_agent can pass it through to the receiving agent for reactions.
  let currentMessageId: string | undefined

  // ── Delegation progress-inquiry timers ───────────────────────────────────
  // When this bot delegates a task, it starts a 2-min timer per delegation.
  // Each timer sends a status-inquiry DELEGATE_TO message to the target bot.
  // Cleared when Manager delivers DELEGATION_COMPLETE (target task finished).
  const delegationTimers = new Map<string, NodeJS.Timeout>()

  function onDelegate(
    delegationId: string,
    targetBotId: string,
    chatId: string,
    replyToMessageId: string | undefined,
  ): void {
    logger.diag(`Delegation timer armed: id=${delegationId} target=${targetBotId}`, botId)
    const timer = setInterval(() => {
      logger.diag(`Delegation inquiry firing: id=${delegationId} target=${targetBotId}`, botId)
      ipcSend({
        type: 'DELEGATE_TO',
        targetBotId,
        chatId,
        fromBotId: botId,
        text: `[进度询问] 请简要汇报当前任务进度：已完成什么，遇到什么问题，下一步计划是什么。`,
        replyToMessageId,
      })
    }, 2 * 60_000)
    delegationTimers.set(delegationId, timer)
  }

  // Delegation tools are always available — agents need to be able to collaborate
  const tools = new ToolRegistry()
  for (const def of createDelegateTools(botId, ipcSend, () => currentMessageId, onDelegate)) tools.register(def)
  tools.register(createSendMessageTool(ipcSend, () => currentMessageId))
  // Workspace tools — read/write workspace/{botId}/ and workspace/common/
  for (const def of createWorkspaceTools(botId)) tools.register(def)
  // Memory tools — read/write MEMORY.md and daily notes
  for (const def of createMemoryTools(botId, memory)) tools.register(def)
  // Shell tool — execute commands with cwd locked to workspace
  for (const def of createShellTools(botId)) tools.register(def)

  // Bitable tools are opt-in via behavior.enableTools
  if (config.behavior.enableTools) {
    const larkClient = new lark.Client({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
    })
    for (const def of createBitableTools(larkClient)) tools.register(def)
  }

  const claude = new ClaudeClient({
    apiKey,
    baseUrl: config.claude.baseUrl,
    model: config.claude.model,
    systemPrompt,
    maxTokens: config.claude.maxTokens,
    tools,
  })

  const persistPath = config.behavior.persistHistory
    ? (chatId: string) => Paths.conversationFile(botId, chatId)
    : undefined
  const store = new ConversationStore(config.claude.historyLimit, persistPath)

  const handler = new MessageHandler(botId, config, claude, store, sender, ipcSend, memory)


  // Error log to same dir as main process
  setProcessLabel(`worker:${botId}`)
  setupErrorLog('error')
  setupDiagLog('logs')   // append only; main process already truncated at startup

  // Signal ready — no Feishu connection needed; the Gateway handles that
  ipcSend({ type: 'READY', botId, pid: process.pid, connectedAt: new Date().toISOString() })

  // Periodic status heartbeat + memory flush
  const statusInterval = setInterval(() => {
    ipcSend({
      type: 'STATUS_UPDATE',
      botId,
      status: BotStatus.READY,
      activeChatCount: store.stats().totalChats,
      lastMessageAt: null,
      restartCount: 0,
    })
    memory.save().catch((err) => logger.warn(`Memory save failed: ${err}`, botId))
  }, 30_000)

  // ─── Per-chatId serialization queue ──────────────────────────────────────
  // Different chatIds run in parallel (independent state, no blocking).
  // Same chatId is serialized (prevents conversation-history race conditions).
  const chatQueues = new Map<string, Promise<void>>()

  function enqueue(chatId: string, fn: () => Promise<void>): void {
    const tail = (chatQueues.get(chatId) ?? Promise.resolve())
      .then(fn)
      .catch((err) => logger.error(`Chat queue error [${chatId}]: ${err}`, botId))
    chatQueues.set(chatId, tail)
    // GC: remove entry once the chain drains so the Map doesn't grow unbounded
    tail.finally(() => {
      if (chatQueues.get(chatId) === tail) chatQueues.delete(chatId)
    })
  }

  // ─── IPC message handler ──────────────────────────────────────────────────
  process.on('message', (raw: unknown) => {
    const msg = raw as DownwardMessage
    switch (msg.type) {
      case 'PING':
        ipcSend({ type: 'PONG', botId, replyTo: msg.id, timestamp: new Date().toISOString() })
        break

      case 'STOP':
        void gracefulShutdown(statusInterval, memory)
        break

      case 'FEISHU_MESSAGE':
        handler.acknowledge(msg.message)  // immediate — fires before queue
        enqueue(msg.message.chatId, () => {
          currentMessageId = msg.message.messageId
          return handler.handle(msg.message).finally(() => { currentMessageId = undefined })
        })
        break

      case 'DELEGATE_MESSAGE':
        enqueue(msg.chatId, () => handler.handleDelegated(msg.chatId, msg.fromBotId, msg.text, msg.replyToMessageId, msg.delegationId))
        break

      case 'DELEGATION_COMPLETE': {
        const timer = delegationTimers.get(msg.delegationId)
        if (timer) {
          clearInterval(timer)
          delegationTimers.delete(msg.delegationId)
          logger.diag(`Delegation timer cleared: id=${msg.delegationId}`, botId)
        }
        break
      }

      case 'SET_BOT_INFO':
        handler.setBotOpenId(msg.botOpenId)
        break

      case 'INJECT_MESSAGE':
        handler
          .handleInjected(msg.chatId, msg.userId, msg.text, msg.syntheticMsgId)
          .catch((err) => {
            ipcSend({ type: 'ERROR', botId, code: 'INJECT_ERROR', message: String(err) })
          })
        break
    }
  })

  // ─── Signal handling ──────────────────────────────────────────────────────
  process.on('SIGTERM', () => void gracefulShutdown(statusInterval, memory))
  process.on('SIGINT',  () => void gracefulShutdown(statusInterval, memory))

  // ─── Unhandled rejection guard ────────────────────────────────────────────
  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled rejection: ${reason}`, botId)
    ipcSend({ type: 'ERROR', botId, code: 'UNHANDLED_REJECTION', message: String(reason) })
  })
}

async function gracefulShutdown(
  statusInterval: NodeJS.Timeout,
  memory: MemoryStore,
): Promise<void> {
  clearInterval(statusInterval)
  await memory.save().catch(() => undefined)
  process.exit(0)
}

main().catch((err) => {
  if (process.send) {
    process.send({ type: 'FATAL', botId, code: 'STARTUP_ERROR', message: String(err), stack: err?.stack })
  }
  process.exit(1)
})
