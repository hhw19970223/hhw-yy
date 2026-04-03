import type { ChildProcess } from 'child_process'
import type { BotStatus } from '../shared/types.js'
import type { LoadedSubAgentConfig } from '../config/schema.js'

export interface PendingReply {
  resolve: (text: string) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export interface BotHandle {
  /** Sub-agent ID (= config.id) */
  botId: string
  /** Main agent that owns this sub-agent */
  mainAgentId: string
  config: LoadedSubAgentConfig
  process: ChildProcess | null
  status: BotStatus
  pid: number | null
  startedAt: Date | null
  lastMessageAt: Date | null
  /** Timestamp of last received PONG (ms since epoch) */
  lastPongAt: number | null
  /** Pending PING request ID; non-null when we're waiting for a PONG */
  pendingPingId: string | null
  /** Timestamp when the most recent PING was sent (ms since epoch) */
  lastPingSentAt: number | null
  restartCount: number
  restartTimer: NodeJS.Timeout | null
  activeChatCount: number
  pendingReplies: Map<string, PendingReply>
}

export function createBotHandle(config: LoadedSubAgentConfig): BotHandle {
  return {
    botId: config.id,
    mainAgentId: config.mainAgentId,
    config,
    process: null,
    status: 'STOPPED',
    pid: null,
    startedAt: null,
    lastMessageAt: null,
    lastPongAt: null,
    pendingPingId: null,
    lastPingSentAt: null,
    restartCount: 0,
    restartTimer: null,
    activeChatCount: 0,
    pendingReplies: new Map(),
  }
}
