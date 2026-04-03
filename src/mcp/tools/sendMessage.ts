import { z } from 'zod'
import type { Manager } from '../../process/Manager.js'

const InputSchema = z.object({
  botId: z.string().describe('The bot to use for sending the message'),
  chatId: z.string().describe('Feishu chat/conversation ID'),
  text: z.string().describe('Message text to send'),
  userId: z.string().optional().describe("Sender's open_id to attribute the message to"),
})

export function sendMessageTool(manager: Manager) {
  return {
    name: 'send_message',
    description: "Inject a message into a bot's conversation and return the bot's reply. Useful for testing or triggering bot responses programmatically.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        botId: { type: 'string', description: 'The bot to use' },
        chatId: { type: 'string', description: 'Feishu chat ID' },
        text: { type: 'string', description: 'Message text' },
        userId: { type: 'string', description: "Sender open_id (optional)" },
      },
      required: ['botId', 'chatId', 'text'],
    },
    handler: async (input: unknown) => {
      const { botId, chatId, text, userId } = InputSchema.parse(input)
      try {
        const reply = await manager.injectMessage(botId, chatId, text, userId)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, botReply: reply }) }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(err) }) }],
          isError: true,
        }
      }
    },
  }
}
