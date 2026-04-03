import { z } from 'zod'
import { readWorkspaceFile, WorkspacePathError } from '../../workspace/WorkspaceManager.js'

const InputSchema = z.object({
  scope: z.string().describe("'common' or a botId"),
  path: z.string().describe('File path relative to the workspace root'),
})

export function workspaceReadTool() {
  return {
    name: 'workspace_read',
    description: "Read the contents of a file from a bot's workspace or the common workspace.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: { type: 'string', description: "'common' or a botId" },
        path: { type: 'string', description: 'File path relative to workspace root' },
      },
      required: ['scope', 'path'],
    },
    handler: async (input: unknown) => {
      const { scope, path } = InputSchema.parse(input)
      try {
        const content = await readWorkspaceFile(scope, path)
        return {
          content: [{ type: 'text' as const, text: content }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
          isError: true,
        }
      }
    },
  }
}
