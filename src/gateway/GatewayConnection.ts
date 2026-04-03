import { FeishuClient, type FeishuMessage } from '../feishu/FeishuClient.js'
import { Sender } from '../feishu/reply/Sender.js'
import { logger } from '../shared/logger.js'

export type GatewayMessageHandler = (msg: FeishuMessage) => void

/**
 * Manages a single Feishu bot's WebSocket connection and outbound API calls.
 * Lives in the main (gateway) process — never in worker processes.
 */
export class GatewayConnection {
  private readonly feishu: FeishuClient
  private readonly sender: Sender
  private botOpenId: string | null = null

  constructor(
    private readonly botId: string,
    feishuConfig: {
      appId: string
      appSecret: string
      encryptKey?: string
      verificationToken?: string
    },
    chunkSize: number,
  ) {
    this.feishu = new FeishuClient(botId, feishuConfig)
    this.sender = new Sender(this.feishu.client, botId, chunkSize)
  }

  onMessage(handler: GatewayMessageHandler): void {
    this.feishu.onMessage(handler)
  }

  async start(): Promise<void> {
    await this.feishu.connect()
    const openId = await this.feishu.getBotOpenId()
    if (openId) this.botOpenId = openId
    logger.info(`Gateway connection ready (openId=${this.botOpenId ?? 'unknown'})`, this.botId)
  }

  async stop(): Promise<void> {
    await this.feishu.disconnect()
  }

  getBotOpenId(): string | null {
    return this.botOpenId
  }

  async sendText(chatId: string, replyToMessageId: string | null, text: string): Promise<string> {
    return this.sender.sendText(chatId, replyToMessageId, text)
  }

  async addReaction(messageId: string, reactionType: string): Promise<void> {
    return this.sender.addReaction(messageId, reactionType)
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    return this.sender.removeReaction(messageId, reactionId)
  }
}
