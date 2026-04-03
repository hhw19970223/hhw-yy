import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

let errorLogDir: string | null = null
let processLabel = 'gateway'

export function setProcessLabel(label: string): void {
  processLabel = label
}

/**
 * Configure the directory for error log files.
 * Each day gets its own file: <dir>/YYYY-MM-DD.log
 * Call once at service startup.
 */
export function setupErrorLog(dir: string): void {
  mkdirSync(dir, { recursive: true })
  errorLogDir = dir
}

function log(level: LogLevel, botId: string | null, message: string, extra?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    process: processLabel,
    message,
  }
  if (botId) entry.botId = botId
  if (extra) Object.assign(entry, extra)

  const line = JSON.stringify(entry) + '\n'
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout
  out.write(line)

  // Write errors to rotating daily file
  if (level === 'error' && errorLogDir) {
    const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    const file = join(errorLogDir, `${date}.log`)
    try {
      appendFileSync(file, line, 'utf8')
    } catch {
      // Silently ignore file write failures to avoid infinite recursion
    }
  }
}

export const logger = {
  debug: (msg: string, botId?: string, extra?: Record<string, unknown>) => log('debug', botId ?? null, msg, extra),
  info:  (msg: string, botId?: string, extra?: Record<string, unknown>) => log('info',  botId ?? null, msg, extra),
  warn:  (msg: string, botId?: string, extra?: Record<string, unknown>) => log('warn',  botId ?? null, msg, extra),
  error: (msg: string, botId?: string, extra?: Record<string, unknown>) => log('error', botId ?? null, msg, extra),
}
