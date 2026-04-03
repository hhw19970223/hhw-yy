import type { FeishuSender } from './reply/Sender.js'
import type { UpwardMessage } from '../process/ipc/types.js'

export type IpcSendFn = (msg: UpwardMessage) => void

/**
 * FeishuSender implementation for worker processes.
 * Forwards all Feishu I/O requests to the main process via IPC,
 * where the Gateway holds the actual Feishu connections.
 */
export class IpcSender implements FeishuSender {
  constructor(private readonly ipcSend: IpcSendFn) {}

  async sendText(chatId: string, replyToMessageId: string | null, text: string): Promise<string> {
    this.ipcSend({ type: 'FEISHU_SEND', chatId, replyToMessageId, text })
    // The actual message ID is returned asynchronously from the Gateway;
    // returning '' here is acceptable since REPLY_SENT.replyId is informational only.
    return ''
  }

  async addReaction(messageId: string, reactionType: string): Promise<void> {
    this.ipcSend({ type: 'FEISHU_REACTION_ADD', messageId, reactionType })
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    this.ipcSend({ type: 'FEISHU_REACTION_REMOVE', messageId, reactionId })
  }
}
