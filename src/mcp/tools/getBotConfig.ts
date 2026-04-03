import { z } from 'zod'
import type { Manager } from '../../process/Manager.js'

const InputSchema = z.object({ botId: z.string() })

export function getBotConfigTool(manager: Manager) {
  return {
    name: 'get_bot_config',
    description: 'Get the effective configuration of a sub-agent (secrets are redacted)',
    inputSchema: {
      type: 'object' as const,
      properties: { botId: { type: 'string', description: 'Sub-agent ID' } },
      required: ['botId'],
    },
    handler: async (input: unknown) => {
      const { botId } = InputSchema.parse(input)
      const snapshot = manager.getSnapshot(botId)
      if (!snapshot) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Sub-agent ${botId} not found` }) }],
          isError: true,
        }
      }

      const config = manager.getBotConfig(botId)
      if (!config) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Config not available` }) }],
          isError: true,
        }
      }

      const redacted = {
        mainAgentId: config.mainAgentId,
        botId: config.id,
        name: config.name ?? config.id,
        feishu: {
          appId: config.feishu.appId,
          appSecret: '***REDACTED***',
          encryptKey: config.feishu.encryptKey ? true : false,
          verificationToken: config.feishu.verificationToken ? true : false,
        },
        claude: {
          model: config.claude.model,
          systemPrompt: config.claude.systemPrompt,
          maxTokens: config.claude.maxTokens,
          historyLimit: config.claude.historyLimit,
          apiKeySource: config.claude.apiKey ? 'config' : process.env.ANTHROPIC_API_KEY ? 'environment' : 'missing',
        },
        access: config.access,
        behavior: config.behavior,
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(redacted, null, 2) }],
      }
    },
  }
}
