import { z } from 'zod'
import { writeWorkspaceFile, WorkspacePathError } from '../../workspace/WorkspaceManager.js'

const InputSchema = z.object({
  scope: z.string().describe("'common' or a botId"),
  path: z.string().describe('File path relative to the workspace root'),
  content: z.string().describe('File content to write'),
})

export function workspaceWriteTool() {
  return {
    name: 'workspace_write',
    description: "Write content to a file in a bot's workspace or the common workspace. Creates the file and any parent directories if they don't exist.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: { type: 'string', description: "'common' or a botId" },
        path: { type: 'string', description: 'File path relative to workspace root' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['scope', 'path', 'content'],
    },
    handler: async (input: unknown) => {
      const { scope, path, content } = InputSchema.parse(input)
      try {
        await writeWorkspaceFile(scope, path, content)
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
