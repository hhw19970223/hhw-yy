import { fork, type ChildProcess } from 'child_process'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import type { LoadedMainAgentConfig, LoadedSubAgentConfig } from '../config/schema.js'
import { BotStatus, type BotSnapshot } from '../shared/types.js'
import { createBotHandle, type BotHandle } from './BotHandle.js'
import { createIpcReceiver } from './ipc/receiver.js'
import { sendToChild } from './ipc/sender.js'
import type { UpwardMessage } from './ipc/types.js'
import { logger } from '../shared/logger.js'
import type { Gateway } from '../gateway/Gateway.js'

const MAX_RESTARTS = 10
const RESTART_DELAY_MS = 1000

export interface HeartbeatConfig {
  intervalMs: number
  timeoutMs: number
}

interface ProgressSession {
  timer: NodeJS.Timeout
  startTime: number
  reasoning: string
  replyToMessageId: string | null
  botId: string
  chatId: string
}

export class Manager {
  private bots = new Map<string, BotHandle>()
  private mainAgentConfigs = new Map<string, LoadedMainAgentConfig>()
  private heartbeatTimer: NodeJS.Timeout | null = null
  /** Progress sessions keyed by "botId:chatId" — timer lives here, not in worker */
  private progressSessions = new Map<string, ProgressSession>()

  constructor(
    private readonly gateway?: Gateway,
    private readonly heartbeatConfig?: HeartbeatConfig,
  ) {
    if (gateway) {
      // Route inbound Feishu messages from the Gateway to the correct worker
      gateway.setMessageHandler((botId, msg) => {
        const handle = this.bots.get(botId)
        if (!handle?.process || handle.status !== BotStatus.READY) {
          logger.warn(`Dropping message for bot ${botId}: not ready`, botId)
          return
        }
        sendToChild(handle.process, { type: 'FEISHU_MESSAGE', message: msg })
      })
    }

    if (heartbeatConfig) {
      this.startHeartbeat(heartbeatConfig.intervalMs, heartbeatConfig.timeoutMs)
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /** Start the main agent's own bot and all its sub-agents */
  async startMainAgent(mainConfig: LoadedMainAgentConfig): Promise<void> {
    this.mainAgentConfigs.set(mainConfig.mainAgentId, mainConfig)

    // Fork the main agent's own Feishu bot (id = mainAgentId)
    const mainBotConfig: LoadedSubAgentConfig = {
      id: mainConfig.mainAgentId,
      name: mainConfig.name,
      feishu: mainConfig.feishu,
      claude: mainConfig.claude,
      access: mainConfig.access,
      behavior: mainConfig.behavior,
      mainAgentId: mainConfig.mainAgentId,
      configPath: mainConfig.configPath,
    }
    await this.startSubAgent(mainBotConfig)

    // Fork sub-agents
    for (const subAgent of mainConfig.subAgents) {
      const config: LoadedSubAgentConfig = {
        ...subAgent,
        mainAgentId: mainConfig.mainAgentId,
        configPath: mainConfig.configPath,
      }
      await this.startSubAgent(config)
    }
  }

  getMainAgentConfig(mainAgentId: string): LoadedMainAgentConfig | null {
    return this.mainAgentConfigs.get(mainAgentId) ?? null
  }

  /** Stop all sub-agents belonging to a main agent */
  stopMainAgent(mainAgentId: string, force = false): void {
    for (const handle of this.bots.values()) {
      if (handle.mainAgentId === mainAgentId) {
        this.stopBot(handle.botId, force)
      }
    }
  }

  stopBot(botId: string, force = false): void {
    const handle = this.bots.get(botId)
    if (!handle || !handle.process || handle.status === BotStatus.STOPPED) {
      logger.warn(`Sub-agent ${botId} is not running`)
      return
    }

    handle.status = BotStatus.STOPPING
    if (force) {
      handle.process.kill('SIGKILL')
    } else {
      sendToChild(handle.process, { type: 'STOP', gracePeriodMs: 10_000 })
      setTimeout(() => {
        if (handle.process && handle.status !== BotStatus.STOPPED) {
          handle.process.kill('SIGKILL')
        }
      }, 12_000)
    }
  }

  async stopAll(): Promise<void> {
    const promises: Promise<void>[] = []
    for (const handle of this.bots.values()) {
      if (handle.process && handle.status !== BotStatus.STOPPED) {
        promises.push(
          new Promise<void>((resolve) => {
            handle.process!.once('exit', () => resolve())
            this.stopBot(handle.botId)
          }),
        )
      }
    }
    await Promise.all(promises)
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  getSnapshot(botId: string): BotSnapshot | null {
    const h = this.bots.get(botId)
    if (!h) return null
    return this.toSnapshot(h)
  }

  listSnapshots(): BotSnapshot[] {
    return Array.from(this.bots.values()).map((h) => this.toSnapshot(h))
  }

  getBotConfig(botId: string): LoadedSubAgentConfig | null {
    return this.bots.get(botId)?.config ?? null
  }

  async injectMessage(
    botId: string,
    chatId: string,
    text: string,
    userId = 'system',
    timeoutMs = 30_000,
  ): Promise<string> {
    const handle = this.bots.get(botId)
    if (!handle || !handle.process || handle.status !== BotStatus.READY) {
      throw new Error(`Sub-agent ${botId} is not ready`)
    }

    const syntheticMsgId = randomUUID()
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        handle.pendingReplies.delete(syntheticMsgId)
        reject(new Error(`Timeout waiting for sub-agent ${botId} reply`))
      }, timeoutMs)

      handle.pendingReplies.set(syntheticMsgId, { resolve, reject, timer })
      sendToChild(handle.process!, { type: 'INJECT_MESSAGE', chatId, userId, text, syntheticMsgId })
    })
  }

  // ─── Heartbeat ────────────────────────────────────────────────────────────

  private startHeartbeat(intervalMs: number, timeoutMs: number): void {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now()
      for (const handle of this.bots.values()) {
        if (handle.status !== BotStatus.READY || !handle.process) continue

        // Check if a previous PING timed out
        if (handle.pendingPingId !== null && handle.lastPingSentAt !== null) {
          if (now - handle.lastPingSentAt > timeoutMs) {
            logger.warn(
              `Heartbeat timeout (${timeoutMs}ms) — killing and restarting`,
              handle.botId,
            )
            handle.pendingPingId = null
            handle.lastPingSentAt = null
            handle.process.kill('SIGKILL')
            // The exit handler will call scheduleRestart
          }
          continue
        }

        // Send a new PING
        const pingId = randomUUID()
        handle.pendingPingId = pingId
        handle.lastPingSentAt = now
        sendToChild(handle.process, { type: 'PING', id: pingId })
      }
    }, intervalMs)
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async startSubAgent(config: LoadedSubAgentConfig): Promise<void> {
    const existing = this.bots.get(config.id)
    if (existing && (existing.status === BotStatus.READY || existing.status === BotStatus.STARTING)) {
      logger.warn(`Sub-agent ${config.id} is already running`, config.id)
      return
    }

    const handle = existing ?? createBotHandle(config)
    handle.config = config
    this.bots.set(config.id, handle)
    this.forkBot(handle)
  }

  private forkBot(handle: BotHandle): void {
    handle.status = BotStatus.STARTING
    handle.startedAt = new Date()
    handle.pendingPingId = null
    handle.lastPingSentAt = null

    const workerPath = this.resolveWorkerPath()
    // argv: [workerPath, rootConfigPath, mainAgentId, subAgentId]
    const args = [handle.config.configPath, handle.mainAgentId, handle.config.id]
    const env = { ...process.env }

    const child: ChildProcess = fork(workerPath, args, {
      env,
      execArgv: workerPath.endsWith('.ts') ? ['--import', 'tsx/esm'] : [],
    })

    handle.process = child
    handle.pid = child.pid ?? null

    const receiver = createIpcReceiver((msg: UpwardMessage) => this.handleIpc(handle, msg))
    child.on('message', receiver)

    child.on('exit', (code, signal) => {
      handle.pid = null
      handle.process = null
      handle.pendingPingId = null
      handle.lastPingSentAt = null

      if (handle.status === BotStatus.STOPPING || code === 0) {
        handle.status = BotStatus.STOPPED
        logger.info(`Sub-agent stopped cleanly`, handle.botId)
        return
      }

      logger.warn(`Sub-agent exited unexpectedly (code=${code}, signal=${signal})`, handle.botId)
      this.scheduleRestart(handle)
    })

    child.on('error', (err) => {
      logger.error(`Sub-agent process error: ${err.message}`, handle.botId)
    })

    logger.info(`Forked sub-agent process (pid=${child.pid})`, handle.botId)
  }

  private scheduleRestart(handle: BotHandle): void {
    if (handle.restartCount >= MAX_RESTARTS) {
      handle.status = BotStatus.CRASHED
      logger.error(
        `Sub-agent exceeded max restarts (${MAX_RESTARTS}), marking as CRASHED`,
        handle.botId,
      )
      return
    }

    handle.restartCount++
    handle.status = BotStatus.STARTING
    logger.info(
      `Restarting sub-agent in ${RESTART_DELAY_MS}ms (attempt ${handle.restartCount}/${MAX_RESTARTS})`,
      handle.botId,
    )
    handle.restartTimer = setTimeout(() => {
      this.forkBot(handle)
    }, RESTART_DELAY_MS)
  }

  private handleIpc(handle: BotHandle, msg: UpwardMessage): void {
    switch (msg.type) {
      case 'READY':
        handle.status = BotStatus.READY
        handle.restartCount = 0 // reset on successful startup
        logger.info(`Sub-agent is ready`, handle.botId)
        // Deliver bot's own open_id so the worker can filter self-messages and @mentions
        if (this.gateway && handle.process) {
          const botOpenId = this.gateway.getBotOpenId(handle.botId)
          if (botOpenId) {
            sendToChild(handle.process, { type: 'SET_BOT_INFO', botOpenId })
          }
        }
        break

      case 'STATUS_UPDATE':
        handle.activeChatCount = msg.activeChatCount
        break

      case 'MESSAGE_RECEIVED':
        handle.lastMessageAt = new Date()
        break

      case 'HEARTBEAT_START': {
        const key = `${handle.botId}:${msg.chatId}`
        if (this.progressSessions.has(key)) {
          logger.warn(`HEARTBEAT_START overriding active session for chat ${msg.chatId}`, handle.botId)
        }
        this.stopProgressSession(key)
        const session: ProgressSession = {
          timer: setInterval(() => this.fireProgressHeartbeat(key), 120_000),
          startTime: Date.now(),
          reasoning: '',
          replyToMessageId: msg.replyToMessageId,
          botId: handle.botId,
          chatId: msg.chatId,
        }
        this.progressSessions.set(key, session)
        logger.diag(`Progress session started: key=${key}`)
        break
      }

      case 'HEARTBEAT_UPDATE': {
        const key = `${handle.botId}:${msg.chatId}`
        const session = this.progressSessions.get(key)
        if (session) session.reasoning = msg.reasoning
        break
      }

      case 'HEARTBEAT_STOP': {
        const key = `${handle.botId}:${msg.chatId}`
        this.stopProgressSession(key)
        logger.diag(`Progress session stopped: key=${key}`)
        break
      }

      case 'REPLY_SENT':
        break

      case 'INJECT_REPLY': {
        const pending = handle.pendingReplies.get(msg.syntheticMsgId)
        if (pending) {
          clearTimeout(pending.timer)
          handle.pendingReplies.delete(msg.syntheticMsgId)
          pending.resolve(msg.replyText)
        }
        break
      }

      case 'PONG':
        if (handle.pendingPingId === msg.replyTo) {
          handle.pendingPingId = null
          handle.lastPingSentAt = null
        }
        handle.lastPongAt = Date.now()
        break

      case 'FATAL':
        handle.status = BotStatus.CRASHED
        logger.error(`Sub-agent fatal error: ${msg.message}`, handle.botId)
        break

      case 'ERROR':
        logger.warn(`Sub-agent error: ${msg.message}`, handle.botId)
        break

      case 'LOG':
        logger.info(msg.message, handle.botId)
        break

      case 'FEISHU_SEND':
        logger.diag(`FEISHU_SEND from bot=${handle.botId} chat=${msg.chatId} len=${msg.text.length}`)
        if (this.gateway) {
          this.gateway
            .sendText(handle.botId, msg.chatId, msg.replyToMessageId, msg.text)
            .catch((err) => logger.error(`Gateway sendText failed: ${err}`, handle.botId))
        } else {
          logger.diag(`FEISHU_SEND dropped — no gateway`, handle.botId)
        }
        break

      case 'FEISHU_REACTION_ADD':
        if (this.gateway) {
          this.gateway
            .addReaction(handle.botId, msg.messageId, msg.reactionType)
            .catch((err) => logger.error(`Gateway addReaction failed: ${err}`, handle.botId))
        }
        break

      case 'FEISHU_REACTION_REMOVE':
        if (this.gateway) {
          this.gateway
            .removeReaction(handle.botId, msg.messageId, msg.reactionId)
            .catch((err) => logger.error(`Gateway removeReaction failed: ${err}`, handle.botId))
        }
        break

      case 'DELEGATE_TO': {
        const targetHandle = this.bots.get(msg.targetBotId)
        if (targetHandle?.process && targetHandle.status === BotStatus.READY) {
          sendToChild(targetHandle.process, {
            type: 'DELEGATE_MESSAGE',
            chatId: msg.chatId,
            fromBotId: msg.fromBotId,
            text: msg.text,
            replyToMessageId: msg.replyToMessageId,
            delegationId: msg.delegationId,
          })
          logger.info(`Delegated → ${msg.targetBotId} in chat ${msg.chatId}`, handle.botId)
        } else {
          logger.warn(`Delegation target "${msg.targetBotId}" not found or not ready`, handle.botId)
        }
        break
      }

      case 'DELEGATE_DONE': {
        const delegatorHandle = this.bots.get(msg.delegatorBotId)
        if (delegatorHandle?.process) {
          sendToChild(delegatorHandle.process, {
            type: 'DELEGATION_COMPLETE',
            delegationId: msg.delegationId,
          })
          logger.diag(`DELEGATE_DONE routed: id=${msg.delegationId} from=${msg.fromBotId} to=${msg.delegatorBotId}`)
        }
        break
      }
    }
  }

  private stopProgressSession(key: string): void {
    const existing = this.progressSessions.get(key)
    if (existing) {
      clearInterval(existing.timer)
      this.progressSessions.delete(key)
    }
  }

  private fireProgressHeartbeat(key: string): void {
    const session = this.progressSessions.get(key)
    if (!session || !this.gateway) return
    const elapsedSec = Math.round((Date.now() - session.startTime) / 1_000)
    const elapsed = elapsedSec >= 60 ? `${Math.round(elapsedSec / 60)} 分钟` : `${elapsedSec} 秒`
    const activity = session.reasoning || '处理中...'
    const text = `【进度更新】正在执行 ${activity}\n已完成：已运行 ${elapsed}\n下一步：继续执行任务`
    logger.diag(`Progress heartbeat firing: key=${key} elapsed=${elapsedSec}s`)
    this.gateway
      .sendText(session.botId, session.chatId, session.replyToMessageId, text)
      .catch((err) => logger.warn(`Progress heartbeat sendText failed: ${err}`, session.botId))
  }

  private toSnapshot(h: BotHandle): BotSnapshot {
    return {
      botId: h.botId,
      mainAgentId: h.mainAgentId,
      name: h.config.name ?? h.botId,
      status: h.status,
      pid: h.pid,
      startedAt: h.startedAt,
      lastMessageAt: h.lastMessageAt,
      lastPingAt: h.lastPongAt ? new Date(h.lastPongAt) : null,
      restartCount: h.restartCount,
      activeChatCount: h.activeChatCount,
    }
  }

  private resolveWorkerPath(): string {
    const thisFile = fileURLToPath(import.meta.url)
    const thisDir = dirname(thisFile)
    const compiled = join(thisDir, 'worker.js')
    const source = join(thisDir, 'worker.ts')
    if (existsSync(compiled)) return compiled
    return source
  }
}
