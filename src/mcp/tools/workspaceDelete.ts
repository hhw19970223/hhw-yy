import { z } from 'zod'
import { deleteWorkspaceFile, WorkspacePathError } from '../../workspace/WorkspaceManager.js'

const InputSchema = z.object({
  scope: z.string().describe("'common' or a botId"),
  path: z.string().describe('File path relative to the workspace root'),
})

export function workspaceDeleteTool() {
  return {
    name: 'workspace_delete',
    description: "Delete a file from a bot's workspace or the common workspace.",
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
        await deleteWorkspaceFile(scope, path)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, scope, path }) }],
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
