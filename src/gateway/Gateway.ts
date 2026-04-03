import { GatewayConnection } from './GatewayConnection.js'
import type { FeishuMessage } from '../feishu/FeishuClient.js'
import { logger } from '../shared/logger.js'

/** Called by the Gateway when a Feishu message arrives for any registered bot. */
export type GatewayRouteHandler = (botId: string, msg: FeishuMessage) => void

/**
 * Central Feishu connection manager.
 *
 * Responsibilities:
 * - Holds all GatewayConnection instances (one per bot).
 * - Aggregates inbound messages and routes them to the registered handler
 *   (i.e. the Manager, which forwards to the correct worker process via IPC).
 * - Exposes outbound helpers (sendText, addReaction, removeReaction) so the
 *   Manager can dispatch IPC requests from workers to the right Feishu bot.
 */
export class Gateway {
  private readonly connections = new Map<string, GatewayConnection>()
  private routeHandler: GatewayRouteHandler | null = null

  /**
   * Register a bot's Feishu credentials before calling startAll().
   * Idempotent — duplicate registrations are silently ignored.
   */
  registerBot(
    botId: string,
    feishuConfig: {
      appId: string
      appSecret: string
      encryptKey?: string
      verificationToken?: string
    },
    chunkSize: number,
  ): void {
    if (this.connections.has(botId)) return

    const conn = new GatewayConnection(botId, feishuConfig, chunkSize)
    conn.onMessage((msg) => {
      if (this.routeHandler) this.routeHandler(botId, msg)
    })
    this.connections.set(botId, conn)
  }

  /**
   * Set the handler that receives inbound messages for all registered bots.
   * Must be called before startAll() so no messages are missed.
   */
  setMessageHandler(handler: GatewayRouteHandler): void {
    this.routeHandler = handler
  }

  /** Connect all registered Feishu bots concurrently. */
  async startAll(): Promise<void> {
    await Promise.all(Array.from(this.connections.values()).map((c) => c.start()))
    logger.info(`Gateway started ${this.connections.size} connection(s)`)
  }

  /** Disconnect all registered Feishu bots. */
  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.connections.values()).map((c) => c.stop()))
    logger.info('Gateway stopped all connections')
  }

  getBotOpenId(botId: string): string | null {
    return this.connections.get(botId)?.getBotOpenId() ?? null
  }

  async sendText(botId: string, chatId: string, replyToMessageId: string | null, text: string): Promise<string> {
    const conn = this.connections.get(botId)
    if (!conn) {
      logger.warn(`FEISHU_SEND: no gateway connection for bot ${botId}`)
      return ''
    }
    return conn.sendText(chatId, replyToMessageId, text)
  }

  async addReaction(botId: string, messageId: string, reactionType: string): Promise<void> {
    await this.connections.get(botId)?.addReaction(messageId, reactionType)
  }

  async removeReaction(botId: string, messageId: string, reactionId: string): Promise<void> {
    await this.connections.get(botId)?.removeReaction(messageId, reactionId)
  }
}
