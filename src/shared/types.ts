export const BotStatus = {
  STARTING: 'STARTING',
  READY: 'READY',
  DEGRADED: 'DEGRADED',
  STOPPING: 'STOPPING',
  STOPPED: 'STOPPED',
  CRASHED: 'CRASHED',
} as const

export type BotStatus = (typeof BotStatus)[keyof typeof BotStatus]

export interface BotSnapshot {
  botId: string
  mainAgentId: string
  name: string
  status: BotStatus
  pid: number | null
  startedAt: Date | null
  lastMessageAt: Date | null
  lastPingAt: Date | null
  restartCount: number
  activeChatCount: number
}
