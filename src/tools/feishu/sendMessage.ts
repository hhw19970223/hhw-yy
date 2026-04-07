import { z } from 'zod'
import type { ToolDef } from '../ToolRegistry.js'
import type { UpwardMessage } from '../../process/ipc/types.js'

const SendMessageInput = z.object({
  chat_id: z.string().describe('飞书会话 ID，从 <current_session> 的 chat_id 读取'),
  text: z.string().describe('要发送的消息内容'),
})

/**
 * Tool that lets an agent send a message to the current Feishu chat mid-task.
 * Primary use case: progress reports during long-running tool loops.
 *
 * getCurrentMessageId: returns the messageId of the message being handled,
 * so progress updates thread under the original message.
 */
export function createSendMessageTool(
  ipcSend: (msg: UpwardMessage) => void,
  getCurrentMessageId: () => string | undefined,
): ToolDef {
  return {
    spec: {
      name: 'send_message',
      description:
        '向当前飞书会话发送一条消息。' +
        '**必须**在执行耗时任务时每隔 2 分钟调用一次，汇报当前进度，' +
        '让用户知道任务仍在进行中。格式参考 TEAM.md 中的进度汇报模板。',
      input_schema: {
        type: 'object' as const,
        properties: {
          chat_id: {
            type: 'string',
            description: '飞书会话 ID，从 <current_session> 的 chat_id 读取',
          },
          text: {
            type: 'string',
            description: '消息内容，进度汇报使用 TEAM.md 中的格式',
          },
        },
        required: ['chat_id', 'text'],
      },
    },

    execute: async (input) => {
      const { chat_id, text } = SendMessageInput.parse(input)
      ipcSend({
        type: 'FEISHU_SEND',
        chatId: chat_id,
        replyToMessageId: getCurrentMessageId() ?? null,
        text,
      })
      return JSON.stringify({ ok: true })
    },
  }
}
