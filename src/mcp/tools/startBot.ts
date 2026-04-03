import { z } from 'zod'
import type { Manager } from '../../process/Manager.js'

const InputSchema = z.object({ mainAgentId: z.string() })

export function startBotTool(manager: Manager) {
  return {
    name: 'start_bot',
    description: 'Start a specific main agent (and all its sub-agents) that is currently stopped or crashed',
    inputSchema: {
      type: 'object' as const,
      properties: { mainAgentId: { type: 'string', description: 'Main agent ID to start' } },
      required: ['mainAgentId'],
    },
    handler: async (input: unknown) => {
      const { mainAgentId } = InputSchema.parse(input)
      const config = manager.getMainAgentConfig(mainAgentId)
      if (!config) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: false, message: `Main agent "${mainAgentId}" not found` }),
            },
          ],
          isError: true,
        }
      }
      await manager.startMainAgent(config)
      const snapshots = manager.listSnapshots().filter((s) => s.mainAgentId === mainAgentId)
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              message: `Main agent ${mainAgentId} starting`,
              subAgents: snapshots.map((s) => ({ botId: s.botId, status: s.status })),
            }),
          },
        ],
      }
    },
  }
}
