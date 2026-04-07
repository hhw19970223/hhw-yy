import { exec } from 'child_process'
import { promisify } from 'util'
import { z } from 'zod'
import type { ToolDef } from '../ToolRegistry.js'
import { resolveWorkspacePath, sanitizePath } from '../../workspace/WorkspaceManager.js'

const execAsync = promisify(exec)

// ─── Safety ───────────────────────────────────────────────────────────────────

/**
 * Block commands that could cause irreversible system-level damage.
 * File operations are safe because cwd is locked to workspace.
 */
const BLOCKED_PATTERNS = [
  /\brm\s+-[^\s]*f[^\s]*\s+\//, // rm -rf /...
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev/,
  /\bsudo\b/,
  /\bsu\s/,
  /\bchmod\s+.*777\s+\//,
  /\bchown\s+.*\/etc/,
  />\s*\/etc\//,                 // redirect into /etc
  />\s*\/proc\//,
]

function isBlocked(command: string): string | null {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return `拒绝执行：命令包含危险模式 (${pattern})`
    }
  }
  return null
}

// ─── Input schema ─────────────────────────────────────────────────────────────

const ShellInput = z.object({
  command: z.string().describe('要执行的 shell 命令'),
  scope: z
    .string()
    .optional()
    .describe('工作目录范围：botId（私有工作区，默认）或 "common"（共享工作区）'),
  workdir: z
    .string()
    .optional()
    .describe('在 workspace 内的子目录（相对路径，可选）'),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(120_000)
    .optional()
    .describe('超时毫秒数，最大 120000，默认 30000'),
})

// ─── Tool factory ─────────────────────────────────────────────────────────────

const MAX_OUTPUT_CHARS = 8000

export function createShellTools(botId: string): ToolDef[] {
  return [
    {
      spec: {
        name: 'shell_exec',
        description:
          '在 workspace 目录下执行 shell 命令（git、npm、python 等均可）。' +
          '工作目录默认为你的私有工作区，也可指定 "common" 共享工作区，或在其中的子目录。' +
          '文件操作（创建/修改/删除）必须在 workspace 目录内完成，禁止操作工作区外的路径。',
        input_schema: {
          type: 'object' as const,
          properties: {
            command: {
              type: 'string',
              description: '要执行的 shell 命令，例如 "git status" 或 "npm install"',
            },
            scope: {
              type: 'string',
              description: `工作目录：你的 botId "${botId}"（默认）或 "common"`,
            },
            workdir: {
              type: 'string',
              description: 'workspace 内的子目录相对路径（可选），例如 "my-repo"',
            },
            timeout_ms: {
              type: 'number',
              description: '超时毫秒数，最大 120000，默认 30000',
            },
          },
          required: ['command'],
        },
      },

      execute: async (input) => {
        const { command, scope, workdir, timeout_ms } = ShellInput.parse(input)

        // Safety check
        const blocked = isBlocked(command)
        if (blocked) return JSON.stringify({ error: blocked })

        // Resolve cwd — always inside workspace
        const root = resolveWorkspacePath(scope ?? botId)
        const cwd = workdir ? sanitizePath(root, workdir) : root

        const timeout = timeout_ms ?? 30_000

        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd,
            timeout,
            maxBuffer: 1024 * 1024, // 1 MB
            shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
          })

          const out = truncate(stdout, MAX_OUTPUT_CHARS)
          const err = truncate(stderr, MAX_OUTPUT_CHARS)

          return JSON.stringify({
            exitCode: 0,
            stdout: out || undefined,
            stderr: err || undefined,
            cwd,
          })
        } catch (err: unknown) {
          const e = err as { code?: number; stdout?: string; stderr?: string; killed?: boolean; message?: string }

          if (e.killed) {
            return JSON.stringify({ error: `命令超时（${timeout}ms）`, cwd })
          }

          return JSON.stringify({
            exitCode: e.code ?? 1,
            stdout: truncate(e.stdout ?? '', MAX_OUTPUT_CHARS) || undefined,
            stderr: truncate(e.stderr ?? '', MAX_OUTPUT_CHARS) || undefined,
            error: e.message,
            cwd,
          })
        }
      },
    },
  ]
}

function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s
  return s.slice(0, maxChars) + `\n…（已截断，共 ${s.length} 字符）`
}
