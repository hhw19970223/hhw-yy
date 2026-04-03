import type { Manager } from '../../process/Manager.js'

export function listBotsTool(manager: Manager) {
  return {
    name: 'list_bots',
    description: 'List all configured Feishu bots and their current status',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
    handler: async () => {
      const snapshots = manager.listSnapshots()
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              snapshots.map((s) => ({
                mainAgentId: s.mainAgentId,
                botId: s.botId,
                name: s.name,
                status: s.status,
                pid: s.pid,
                uptimeSeconds: s.startedAt ? Math.floor((Date.now() - new Date(s.startedAt).getTime()) / 1000) : null,
                restartCount: s.restartCount,
                lastMessageAt: s.lastMessageAt,
                activeChatCount: s.activeChatCount,
              })),
              null,
              2,
            ),
          },
        ],
      }
    },
  }
}
