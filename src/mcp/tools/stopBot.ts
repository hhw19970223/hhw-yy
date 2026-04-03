import { z } from 'zod'
import type { Manager } from '../../process/Manager.js'

const InputSchema = z.object({
  botId: z.string(),
  force: z.boolean().default(false),
})

export function stopBotTool(manager: Manager) {
  return {
    name: 'stop_bot',
    description: 'Stop a specific running bot gracefully',
    inputSchema: {
      type: 'object' as const,
      properties: {
        botId: { type: 'string' },
        force: { type: 'boolean', description: 'Force kill immediately (default: false)' },
      },
      required: ['botId'],
    },
    handler: async (input: unknown) => {
      const { botId, force } = InputSchema.parse(input)
      const snapshot = manager.getSnapshot(botId)
      if (!snapshot) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, message: `Bot ${botId} not found` }) }],
          isError: true,
        }
      }
      manager.stopBot(botId, force)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, message: `Bot ${botId} stop signal sent` }) }],
      }
    },
  }
}
