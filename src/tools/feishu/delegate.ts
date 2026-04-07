import { z } from 'zod'
import type { ToolDef } from '../ToolRegistry.js'
import type { UpwardMessage } from '../../process/ipc/types.js'

// ─── Input schema ─────────────────────────────────────────────────────────────

const DelegateInput = z.object({
  target_bot_id: z.string().describe('目标 Agent 的 ID（见 workspace/common/TEAM.md）'),
  message: z.string().describe('委托内容，清晰说明需要对方做什么以及背景'),
  chat_id: z.string().describe('当前飞书会话 ID（从系统上下文 <current_session> 的 chat_id 字段读取）'),
})

// ─── Tool factory ─────────────────────────────────────────────────────────────

export function createDelegateTools(
  botId: string,
  ipcSend: (msg: UpwardMessage) => void,
  getCurrentMessageId: () => string | undefined,
): ToolDef[] {
  return [
    {
      spec: {
        name: 'delegate_to_agent',
        description:
          '将任务委托给另一个 Agent，对方会在当前飞书会话中直接回复。' +
          '委托前请查阅 workspace/common/TEAM.md 确认目标 Agent 的 ID 和职责。' +
          '当前会话 ID 可从系统上下文 <current_session> 的 chat_id 字段获取。',
        input_schema: {
          type: 'object' as const,
          properties: {
            target_bot_id: {
              type: 'string',
              description: '目标 Agent 的 ID，见 workspace/common/TEAM.md',
            },
            message: {
              type: 'string',
              description: '委托内容，要说清楚：做什么、背景是什么、期望什么输出',
            },
            chat_id: {
              type: 'string',
              description: '当前飞书会话 ID，从 <current_session> 的 chat_id 字段读取',
            },
          },
          required: ['target_bot_id', 'message', 'chat_id'],
        },
      },
      execute: async (input) => {
        const { target_bot_id, message, chat_id } = DelegateInput.parse(input)

        if (target_bot_id === botId) {
          return JSON.stringify({ error: '不能委托给自己' })
        }

        ipcSend({
          type: 'DELEGATE_TO',
          targetBotId: target_bot_id,
          chatId: chat_id,
          fromBotId: botId,
          text: `[来自 ${botId} 的委托]\n\n${message}`,
          replyToMessageId: getCurrentMessageId(),
        })

        return JSON.stringify({
          ok: true,
          delegated_to: target_bot_id,
          chat_id,
          note: '委托已发出，目标 Agent 将在当前飞书会话中直接回复',
        })
      },
    },
  ]
}
