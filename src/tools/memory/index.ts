import { readFile } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod'
import type { ToolDef } from '../ToolRegistry.js'
import type { MemoryStore } from '../../memory/MemoryStore.js'
import { Paths } from '../../config/paths.js'

// ─── Input schemas ────────────────────────────────────────────────────────────

const ReadMemoryInput = z.object({
  type: z
    .enum(['long_term', 'today', 'recent'])
    .describe(
      'long_term = MEMORY.md（长期记忆索引），today = 今天的日记，recent = 最近 3 天的日记',
    ),
})

const AppendMemoryInput = z.object({
  note: z.string().describe('要追加到今日记忆的内容，简洁记录重要事项、决策或偏好'),
})

const WriteLongTermInput = z.object({
  content: z.string().describe('MEMORY.md 的完整新内容（覆盖写入，请保留已有条目并追加新内容）'),
})

// ─── Tool factory ─────────────────────────────────────────────────────────────

export function createMemoryTools(botId: string, memory: MemoryStore): ToolDef[] {
  const memoryMdPath = join(Paths.agentDir(botId), 'MEMORY.md')

  return [
    {
      spec: {
        name: 'memory_read',
        description:
          '读取记忆内容。long_term 读取 MEMORY.md（跨会话长期记忆），today 读取今日日记，recent 读取近 3 天日记。',
        input_schema: {
          type: 'object' as const,
          properties: {
            type: {
              type: 'string',
              enum: ['long_term', 'today', 'recent'],
              description: 'long_term = MEMORY.md，today = 今日日记，recent = 近 3 天',
            },
          },
          required: ['type'],
        },
      },
      execute: async (input) => {
        const { type } = ReadMemoryInput.parse(input)

        if (type === 'long_term') {
          try {
            return await readFile(memoryMdPath, 'utf8')
          } catch {
            return '（MEMORY.md 为空或不存在）'
          }
        }

        if (type === 'today') {
          const content = memory.today()
          return content.trim() || '（今日暂无记忆）'
        }

        // recent
        const recent = await memory.recent(3)
        return recent.trim() || '（暂无近期记忆）'
      },
    },

    {
      spec: {
        name: 'memory_append',
        description:
          '向今日记忆日记追加一条记录（带时间戳）。用于记录重要的用户偏好、决策、待跟进事项等。',
        input_schema: {
          type: 'object' as const,
          properties: {
            note: {
              type: 'string',
              description: '要记录的内容，简洁明确',
            },
          },
          required: ['note'],
        },
      },
      execute: async (input) => {
        const { note } = AppendMemoryInput.parse(input)
        memory.append(note)
        await memory.save()
        return JSON.stringify({ ok: true, note: '已追加到今日记忆' })
      },
    },

    {
      spec: {
        name: 'memory_write_long_term',
        description:
          '覆盖写入 MEMORY.md（长期记忆）。请先用 memory_read(long_term) 读取现有内容，在保留已有条目的基础上追加或更新，再整体写回。',
        input_schema: {
          type: 'object' as const,
          properties: {
            content: {
              type: 'string',
              description: 'MEMORY.md 的完整新内容',
            },
          },
          required: ['content'],
        },
      },
      execute: async (input) => {
        const { content } = WriteLongTermInput.parse(input)
        const { writeFile } = await import('fs/promises')
        await writeFile(memoryMdPath, content, 'utf8')
        return JSON.stringify({ ok: true, note: 'MEMORY.md 已更新' })
      },
    },
  ]
}
