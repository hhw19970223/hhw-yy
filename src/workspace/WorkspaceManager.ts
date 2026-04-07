import { readdir, readFile, writeFile, unlink, mkdir, stat } from 'fs/promises'
import { join, normalize, resolve, dirname, sep } from 'path'
import { Paths } from '../config/paths.js'

// ─── Errors ──────────────────────────────────────────────────────────────────

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspacePathError'
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WorkspaceEntry {
  name: string
  isDirectory: boolean
  sizeBytes: number
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

export function resolveWorkspacePath(scope: string): string {
  return scope === 'common' ? Paths.workspaceCommon : Paths.workspaceBot(scope)
}

/**
 * Resolve a relative path within a workspace root.
 * Throws WorkspacePathError if the resolved path escapes the root.
 */
export function sanitizePath(root: string, relativePath: string): string {
  const normalized = normalize(relativePath)
  const resolved = resolve(root, normalized)
  const rootWithSep = root.endsWith(sep) ? root : root + sep
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new WorkspacePathError(
      `Path "${relativePath}" escapes workspace root`,
    )
  }
  return resolved
}

// ─── File operations ──────────────────────────────────────────────────────────

export async function listWorkspace(
  scope: string,
  subPath?: string,
): Promise<WorkspaceEntry[]> {
  const root = resolveWorkspacePath(scope)
  const dir = subPath ? sanitizePath(root, subPath) : root

  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const results = await Promise.all(
      entries.map(async (e) => {
        let sizeBytes = 0
        if (!e.isDirectory()) {
          const s = await stat(join(dir, e.name)).catch(() => null)
          sizeBytes = s?.size ?? 0
        }
        return { name: e.name, isDirectory: e.isDirectory(), sizeBytes }
      }),
    )
    return results
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

export async function readWorkspaceFile(scope: string, filePath: string): Promise<string> {
  const root = resolveWorkspacePath(scope)
  const resolved = sanitizePath(root, filePath)
  return readFile(resolved, 'utf8')
}

export async function writeWorkspaceFile(
  scope: string,
  filePath: string,
  content: string,
): Promise<void> {
  const root = resolveWorkspacePath(scope)
  const resolved = sanitizePath(root, filePath)
  await mkdir(dirname(resolved), { recursive: true })
  await writeFile(resolved, content, 'utf8')
}

export async function deleteWorkspaceFile(scope: string, filePath: string): Promise<void> {
  const root = resolveWorkspacePath(scope)
  const resolved = sanitizePath(root, filePath)
  await unlink(resolved)
}

// ─── Binary detection ─────────────────────────────────────────────────────────

function isBinaryBuffer(buf: Buffer): boolean {
  const len = Math.min(buf.length, 512)
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0x00) return true
  }
  return false
}

// ─── System prompt context builder ───────────────────────────────────────────

const MAX_INLINE_BYTES = 4096

async function buildScopeContext(scope: string, label: string): Promise<string> {
  const root = resolveWorkspacePath(scope)
  let entries: WorkspaceEntry[]
  try {
    entries = await listWorkspace(scope)
  } catch {
    return `[${label}]\n(error reading workspace)\n`
  }

  if (entries.length === 0) {
    return `[${label}]\n(empty)\n`
  }

  const lines: string[] = [`[${label}]`]

  for (const entry of entries) {
    if (entry.isDirectory) {
      lines.push(`- ${entry.name}/ (directory)`)
      continue
    }

    const sizeLabel = entry.sizeBytes < 1024
      ? `${entry.sizeBytes} B`
      : `${(entry.sizeBytes / 1024).toFixed(1)} KB`

    if (entry.sizeBytes > MAX_INLINE_BYTES) {
      lines.push(`- ${entry.name} (${sizeLabel}) [content omitted: too large]`)
      continue
    }

    try {
      const buf = await readFile(join(root, entry.name))
      if (isBinaryBuffer(buf)) {
        lines.push(`- ${entry.name} (${sizeLabel}) [binary file]`)
        continue
      }
      const content = buf.toString('utf8')
      lines.push(`- ${entry.name} (${sizeLabel})\n  <content>\n${content}\n  </content>`)
    } catch {
      lines.push(`- ${entry.name} (${sizeLabel}) [unreadable]`)
    }
  }

  return lines.join('\n') + '\n'
}

/**
 * Build a workspace context string to inject into a bot's system prompt.
 * Returns empty string if both workspaces are empty (avoids noisy prompts).
 */
export async function buildWorkspaceContext(botId: string): Promise<string> {
  const [botCtx, commonCtx] = await Promise.all([
    buildScopeContext(botId, `bot: ${botId}`),
    buildScopeContext('common', 'common'),
  ])

  const bothEmpty =
    botCtx.includes('(empty)') && commonCtx.includes('(empty)')
  if (bothEmpty) return ''

  return `<workspace>\n${botCtx}\n${commonCtx}</workspace>`
}
