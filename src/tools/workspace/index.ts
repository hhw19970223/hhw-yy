import { z } from 'zod'
import type { ToolDef } from '../ToolRegistry.js'
import {
  listWorkspace,
  readWorkspaceFile,
  writeWorkspaceFile,
  deleteWorkspaceFile,
  WorkspacePathError,
} from '../../workspace/WorkspaceManager.js'

// ─── Input schemas ────────────────────────────────────────────────────────────

const ListInput = z.object({
  scope: z.string().describe('工作区范围：使用自己的 botId 访问私有工作区，或 "common" 访问共享工作区'),
  path: z.string().optional().describe('子目录路径（可选），留空则列出根目录'),
})

const ReadInput = z.object({
  scope: z.string().describe('工作区范围：botId 或 "common"'),
  path: z.string().describe('文件相对路径，例如 "notes.md" 或 "subdir/file.txt"'),
})

const WriteInput = z.object({
  scope: z.string().describe('工作区范围：botId 或 "common"'),
  path: z.string().describe('文件相对路径'),
  content: z.string().describe('文件内容（UTF-8 文本）'),
})

const DeleteInput = z.object({
  scope: z.string().describe('工作区范围：botId 或 "common"'),
  path: z.string().describe('要删除的文件相对路径'),
})

// ─── Tool factory ─────────────────────────────────────────────────────────────

export function createWorkspaceTools(botId: string): ToolDef[] {
  return [
    {
      spec: {
        name: 'workspace_list',
        description:
          '列出工作区目录内容。' +
          `你的私有工作区 scope 为 "${botId}"，共享工作区 scope 为 "common"。` +
          '可读取共享工作区的团队文档、项目文件等。',
        input_schema: {
          type: 'object' as const,
          properties: {
            scope: { type: 'string', description: `工作区范围：你的 botId "${botId}" 或 "common"` },
            path: { type: 'string', description: '子目录路径（可选）' },
          },
          required: ['scope'],
        },
      },
      execute: async (input) => {
        const { scope, path } = ListInput.parse(input)
        try {
          const entries = await listWorkspace(scope, path)
          if (entries.length === 0) return JSON.stringify({ entries: [], note: '目录为空' })
          return JSON.stringify({
            entries: entries.map((e) => ({
              name: e.name,
              type: e.isDirectory ? 'directory' : 'file',
              sizeBytes: e.isDirectory ? undefined : e.sizeBytes,
            })),
          })
        } catch (err) {
          if (err instanceof WorkspacePathError) return JSON.stringify({ error: err.message })
          throw err
        }
      },
    },

    {
      spec: {
        name: 'workspace_read',
        description: '读取工作区中的文件内容。',
        input_schema: {
          type: 'object' as const,
          properties: {
            scope: { type: 'string', description: `工作区范围："${botId}" 或 "common"` },
            path: { type: 'string', description: '文件相对路径' },
          },
          required: ['scope', 'path'],
        },
      },
      execute: async (input) => {
        const { scope, path } = ReadInput.parse(input)
        try {
          const content = await readWorkspaceFile(scope, path)
          // Hard cap: prevent single large files from blowing out the context window.
          // 50 000 chars ≈ 12 500 tokens — enough for any reasonably-sized source file.
          const MAX_CHARS = 50_000
          if (content.length > MAX_CHARS) {
            return (
              content.slice(0, MAX_CHARS) +
              `\n\n[文件内容已截断：原始大小 ${content.length} 字符，仅显示前 ${MAX_CHARS} 字符。如需读取后续内容，请分段请求。]`
            )
          }
          return content
        } catch (err) {
          if (err instanceof WorkspacePathError) return JSON.stringify({ error: err.message })
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return JSON.stringify({ error: `文件不存在: ${path}` })
          }
          throw err
        }
      },
    },

    {
      spec: {
        name: 'workspace_write',
        description: '向工作区写入文件（不存在则创建，已存在则覆盖）。',
        input_schema: {
          type: 'object' as const,
          properties: {
            scope: { type: 'string', description: `工作区范围："${botId}" 或 "common"` },
            path: { type: 'string', description: '文件相对路径' },
            content: { type: 'string', description: '文件内容' },
          },
          required: ['scope', 'path', 'content'],
        },
      },
      execute: async (input) => {
        const { scope, path, content } = WriteInput.parse(input)
        try {
          await writeWorkspaceFile(scope, path, content)
          return JSON.stringify({ ok: true, path, scope })
        } catch (err) {
          if (err instanceof WorkspacePathError) return JSON.stringify({ error: err.message })
          throw err
        }
      },
    },

    {
      spec: {
        name: 'workspace_delete',
        description: '删除工作区中的文件。',
        input_schema: {
          type: 'object' as const,
          properties: {
            scope: { type: 'string', description: `工作区范围："${botId}" 或 "common"` },
            path: { type: 'string', description: '要删除的文件相对路径' },
          },
          required: ['scope', 'path'],
        },
      },
      execute: async (input) => {
        const { scope, path } = DeleteInput.parse(input)
        try {
          await deleteWorkspaceFile(scope, path)
          return JSON.stringify({ ok: true, deleted: path, scope })
        } catch (err) {
          if (err instanceof WorkspacePathError) return JSON.stringify({ error: err.message })
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return JSON.stringify({ error: `文件不存在: ${path}` })
          }
          throw err
        }
      },
    },
  ]
}
