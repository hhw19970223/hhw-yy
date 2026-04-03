import { z } from 'zod'
import { listWorkspace, WorkspacePathError } from '../../workspace/WorkspaceManager.js'

const InputSchema = z.object({
  scope: z.string().describe("'common' or a botId"),
  path: z.string().optional().describe('Sub-path within the workspace (optional)'),
})

export function workspaceListTool() {
  return {
    name: 'workspace_list',
    description: "List files in a bot's private workspace or the common workspace.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: { type: 'string', description: "'common' or a botId (e.g. '服务端-agent')" },
        path: { type: 'string', description: 'Sub-directory path within the workspace (optional)' },
      },
      required: ['scope'],
    },
    handler: async (input: unknown) => {
      const { scope, path } = InputSchema.parse(input)
      try {
        const entries = await listWorkspace(scope, path)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(entries, null, 2) }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
          isError: err instanceof WorkspacePathError,
        }
      }
    },
  }
}
