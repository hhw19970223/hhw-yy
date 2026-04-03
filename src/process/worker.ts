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
import { join } from 'path'
import { RootConfigSchema, type LoadedSubAgentConfig } from '../config/schema.js'
import { IpcSender } from '../feishu/IpcSender.js'
import { ClaudeClient } from '../llm/ClaudeClient.js'
import { ConversationStore } from '../session/ConversationStore.js'
import { MemoryStore } from '../memory/MemoryStore.js'
import { MessageHandler } from '../feishu/MessageHandler.js'
import { logger, setupErrorLog, setProcessLabel } from '../shared/logger.js'
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

  // Initialize components
  const sender = new IpcSender(ipcSend)
  const claude = new ClaudeClient({
    apiKey,
    baseUrl: config.claude.baseUrl,
    model: config.claude.model,
    systemPrompt: config.claude.systemPrompt,
    maxTokens: config.claude.maxTokens,
  })

  const persistPath = config.behavior.persistHistory
    ? (chatId: string) => Paths.conversationFile(botId, chatId)
    : undefined
  const store = new ConversationStore(config.claude.historyLimit, persistPath)
  const handler = new MessageHandler(botId, config, claude, store, sender, ipcSend)

  // Memory — persisted to memory/{botId}/store.json relative to cwd
  const memoryFile = join(process.cwd(), 'memory', botId, 'store.json')
  const memory = new MemoryStore()
  await memory.load(memoryFile)

  // Error log to same dir as main process
  setProcessLabel(`worker:${botId}`)
  setupErrorLog('error')

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
    memory.evictExpired()
    memory.save(memoryFile).catch((err) => logger.warn(`Memory save failed: ${err}`, botId))
  }, 30_000)

  // ─── IPC message handler ──────────────────────────────────────────────────
  process.on('message', (raw: unknown) => {
    const msg = raw as DownwardMessage
    switch (msg.type) {
      case 'PING':
        ipcSend({ type: 'PONG', botId, replyTo: msg.id, timestamp: new Date().toISOString() })
        break

      case 'STOP':
        void gracefulShutdown(statusInterval, memory, memoryFile)
        break

      case 'FEISHU_MESSAGE':
        handler.handle(msg.message).catch((err) => {
          logger.error(`Unhandled error in message handler: ${err}`, botId)
        })
        break

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
  process.on('SIGTERM', () => void gracefulShutdown(statusInterval, memory, memoryFile))
  process.on('SIGINT',  () => void gracefulShutdown(statusInterval, memory, memoryFile))

  // ─── Unhandled rejection guard ────────────────────────────────────────────
  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled rejection: ${reason}`, botId)
    ipcSend({ type: 'ERROR', botId, code: 'UNHANDLED_REJECTION', message: String(reason) })
  })
}

async function gracefulShutdown(
  statusInterval: NodeJS.Timeout,
  memory: MemoryStore,
  memoryFile: string,
): Promise<void> {
  clearInterval(statusInterval)
  await memory.save(memoryFile).catch(() => undefined)
  process.exit(0)
}

main().catch((err) => {
  if (process.send) {
    process.send({ type: 'FATAL', botId, code: 'STARTUP_ERROR', message: String(err), stack: err?.stack })
  }
  process.exit(1)
})
