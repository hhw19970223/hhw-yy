import { z } from 'zod'
import type { Manager } from '../../process/Manager.js'

const InputSchema = z.object({
  botId: z.string(),
  chatId: z.string(),
  limit: z.number().int().positive().default(10),
})

// Note: ConversationStore lives in the worker process.
// For the MVP, the manager doesn't have direct access to history.
// We expose what we know from snapshots and flag this as a future enhancement.
export function getHistoryTool(manager: Manager) {
  return {
    name: 'get_history',
    description: 'Get bot status and available chat information. Full conversation history requires bot process communication (future enhancement).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        botId: { type: 'string' },
        chatId: { type: 'string' },
        limit: { type: 'number', description: 'Max turns to return' },
      },
      required: ['botId', 'chatId'],
    },
    handler: async (input: unknown) => {
      const { botId, chatId } = InputSchema.parse(input)
      const snapshot = manager.getSnapshot(botId)
      if (!snapshot) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Bot ${botId} not found` }) }],
          isError: true,
        }
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              botId,
              chatId,
              botStatus: snapshot.status,
              lastMessageAt: snapshot.lastMessageAt,
              note: 'Conversation history is stored in the bot worker process. Use send_message to interact.',
            }),
          },
        ],
      }
    },
  }
}
