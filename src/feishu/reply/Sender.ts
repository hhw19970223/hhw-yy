import * as lark from '@larksuiteoapi/node-sdk'
import { formatToPost, chunkText, type FeishuPostContent } from './Formatter.js'
import { logger } from '../../shared/logger.js'

export interface FeishuSender {
  sendText(chatId: string, replyToMessageId: string | null, text: string): Promise<string>
  addReaction(messageId: string, reactionType: string): Promise<void>
  removeReaction(messageId: string, reactionId: string): Promise<void>
}

export class Sender implements FeishuSender {
  constructor(
    private readonly client: lark.Client,
    private readonly botId: string,
    private readonly chunkSize: number,
  ) {}

  async sendText(chatId: string, replyToMessageId: string | null, text: string): Promise<string> {
    const chunks = chunkText(text, this.chunkSize)
    if (chunks.length > 1) {
      logger.warn(`Reply split into ${chunks.length} chunks (len=${text.length}, chunkSize=${this.chunkSize}) for chat=${chatId}`, this.botId)
    }
    let lastMsgId = ''
    for (const chunk of chunks) {
      const post = formatToPost(chunk)
      lastMsgId = await this.sendPost(chatId, replyToMessageId, post)
      replyToMessageId = null // Only thread the first chunk
    }
    return lastMsgId
  }

  private async sendPost(
    chatId: string,
    replyToMessageId: string | null,
    post: FeishuPostContent,
  ): Promise<string> {
    const content = JSON.stringify(post)
    try {
      if (replyToMessageId) {
        const res = await this.client.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { msg_type: 'post', content },
        })
        return res.data?.message_id ?? ''
      } else {
        const res = await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'post', content },
        })
        return res.data?.message_id ?? ''
      }
    } catch (err) {
      logger.error(`Failed to send message: ${err}`, this.botId)
      throw err
    }
  }

  async addReaction(messageId: string, reactionType: string): Promise<void> {
    try {
      await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: reactionType } },
      })
    } catch {
      // Reaction failure is non-critical
    }
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    try {
      await this.client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      })
    } catch {
      // Ignore
    }
  }
}
