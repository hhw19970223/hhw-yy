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
import { RootConfigSchema, type LoadedSubAgentConfig } from '../config/schema.js'
import { loadAgentPrompt } from '../config/agentPrompt.js'
import { initWorkspace } from '../workspace/WorkspaceInit.js'
import { FeishuClient } from '../feishu/FeishuClient.js'
import { Sender } from '../feishu/reply/Sender.js'
import { ClaudeCodeClient } from '../llm/ClaudeCodeClient.js'
import { ConversationStore } from '../session/ConversationStore.js'
import { MemoryStore } from '../memory/MemoryStore.js'
import { MessageHandler } from '../feishu/MessageHandler.js'
import { logger, setupErrorLog, setupDiagLog, setProcessLabel } from '../shared/logger.js'
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

  // Initialize full workspace structure (idempotent)
  // - agents/{botId}/: IDENTITY.md, SOUL.md, AGENTS.md, TOOLS.md, memory/
  // - workspace/{botId}/: bot private working directory
  // - workspace/common/: shared workspace with README
  await initWorkspace(botId)

  // Load system prompt from agents/{botId}/ markdown files
  const systemPrompt = await loadAgentPrompt(botId)

  // Initialize direct Feishu connection in this Agent process.
  // The main process no longer owns Feishu WebSocket/API I/O.
  const feishu = new FeishuClient(botId, config.feishu)
  const sender = new Sender(feishu.client, botId, config.behavior.chunkSize)

  // Memory — markdown daily notes in agents/{botId}/memory/
  // Must initialize before tools so createMemoryTools can reference it
  const memory = new MemoryStore()
  await memory.load(Paths.agentMemoryDir(botId))

  // Track the Feishu messageId of the message currently being processed.
  let currentMessageId: string | undefined

  // ── Delegation progress-inquiry timers ───────────────────────────────────
  // When this bot delegates a task, it starts a 2-min timer per delegation.
  // Each timer sends a status-inquiry DELEGATE_TO message to the target bot.
  // Cleared when Manager delivers DELEGATION_COMPLETE (target task finished).
  const delegationTimers = new Map<string, NodeJS.Timeout>()

  const claude = new ClaudeCodeClient({
    botId,
    model: config.claude.model,
    httpPort: parsed.data.gateway.port,
    systemPrompt: [
      systemPrompt,
      '',
      '<runtime>',
      '你正在 Claude Code CLI 内运行。你可以直接使用 Claude Code 内置文件与 Bash 能力操作允许目录。',
      '你可以使用 MCP 工具 delegate_to_agent（在 Claude Code 中可能显示为 mcp__sl_agent_tools__delegate_to_agent）把任务委托给其他 Agent。',
      '需要联网搜索或打开网页时，使用 MCP 工具 WebSearch / WebFetch（在 Claude Code 中可能显示为 mcp__sl_agent_tools__WebSearch / mcp__sl_agent_tools__WebFetch）；WebSearch 由 DuckDuckGo 提供结果。',
      '委托时 target_bot_id 使用团队 Agent ID，chat_id 从 <current_session> 读取，message 写清背景、任务和期望产出。',
      '不要调用 send_message、workspace_*、memory_*、shell_exec、bitable_* 这些旧版自定义工具名；当前主执行链路不再注册这些 Anthropic SDK tools。',
      '需要记录长期记忆时，直接编辑 agents/{botId}/MEMORY.md 或 agents/{botId}/memory/YYYY-MM-DD.md。',
      '需要产出工作文件时，直接写入 workspace/{botId}/ 或 workspace/common/。',
      '</runtime>',
    ].join('\n'),
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

  feishu.onMessage((message) => {
    handler.acknowledge(message)
    enqueue(message.chatId, () => {
      currentMessageId = message.messageId
      return handler.handle(message).finally(() => { currentMessageId = undefined })
    })
  })

  await feishu.connect()
  const botOpenId = await feishu.getBotOpenId()
  if (botOpenId) handler.setBotOpenId(botOpenId)

  // Signal ready after the Agent's own Feishu connection is established.
  ipcSend({ type: 'READY', botId, pid: process.pid, connectedAt: new Date().toISOString() })

  // Periodic status heartbeat + memory flush
  const statusInterval = setInterval(() => {
    ipcSend({ type: 'STATUS_UPDATE', botId, activeChatCount: store.stats().totalChats })
    memory.save().catch((err) => logger.warn(`Memory save failed: ${err}`, botId))
  }, 30_000)

  // ─── IPC message handler ──────────────────────────────────────────────────
  process.on('message', (raw: unknown) => {
    const msg = raw as DownwardMessage
    switch (msg.type) {
      case 'PING':
        ipcSend({ type: 'PONG', botId, replyTo: msg.id, timestamp: new Date().toISOString() })
        break

      case 'STOP':
        void gracefulShutdown(statusInterval, memory, feishu)
        break

      case 'FEISHU_MESSAGE':
        logger.warn('Ignoring FEISHU_MESSAGE from main process; worker owns Feishu directly', botId)
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

      case 'FEISHU_SEND_DIRECT':
        sender
          .sendText(msg.chatId, msg.replyToMessageId, msg.text)
          .catch((err) => logger.warn(`Direct Feishu send failed: ${err}`, botId))
        break

      case 'INJECT_MESSAGE':
        handler
          .handleInjected(msg.chatId, msg.userId, msg.text, msg.syntheticMsgId)
          .catch((err) => {
            ipcSend({ type: 'ERROR', botId, code: 'INJECT_ERROR', message: String(err) })
          })
        break

      case 'WEB_MESSAGE':
        enqueue(msg.chatId, async () => {
          if (msg.startDelayMs && msg.startDelayMs > 0) {
            await sleep(msg.startDelayMs)
          }
          return handler.handleWebMessage(msg.chatId, msg.userId, msg.text, msg.messageId, msg.routeMode, msg.history).catch((err) => {
            ipcSend({ type: 'ERROR', botId, code: 'WEB_HANDLE_ERROR', message: String(err) })
          })
        })
        break
    }
  })

  // ─── Signal handling ──────────────────────────────────────────────────────
  process.on('SIGTERM', () => void gracefulShutdown(statusInterval, memory, feishu))
  process.on('SIGINT',  () => void gracefulShutdown(statusInterval, memory, feishu))

  // ─── Unhandled rejection guard ────────────────────────────────────────────
  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled rejection: ${reason}`, botId)
    ipcSend({ type: 'ERROR', botId, code: 'UNHANDLED_REJECTION', message: String(reason) })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function gracefulShutdown(
  statusInterval: NodeJS.Timeout,
  memory: MemoryStore,
  feishu?: FeishuClient,
): Promise<void> {
  clearInterval(statusInterval)
  await memory.save().catch(() => undefined)
  await feishu?.disconnect().catch(() => undefined)
  process.exit(0)
}

main().catch((err) => {
  if (process.send) {
    process.send({ type: 'FATAL', botId, code: 'STARTUP_ERROR', message: String(err), stack: err?.stack })
  }
  process.exit(1)
})
