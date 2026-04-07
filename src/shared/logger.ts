import { appendFileSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

let errorLogDir: string | null = null
let diagLogPath: string | null = null
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

/**
 * Set up the diagnostic (troubleshooting) log file at <dir>/diag.log.
 *
 * truncate=true  — clears the file on call. Call from the main process at
 *                  startup so each run starts with a clean slate.
 * truncate=false — just configures the path for appending. Call from worker
 *                  processes (they start after the main process has truncated).
 */
export function setupDiagLog(dir: string, truncate = false): void {
  mkdirSync(dir, { recursive: true })
  diagLogPath = join(dir, 'diag.log')
  if (truncate) {
    writeFileSync(diagLogPath, `# Diagnostic log — started ${new Date().toISOString()}\n`, 'utf8')
  }
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

  /**
   * Write a diagnostic / troubleshooting entry to logs/diag.log.
   * Also echoes to stdout so it appears in the terminal.
   * The file is reset on each startup (setupDiagLog with truncate=true).
   */
  diag: (msg: string, botId?: string, extra?: Record<string, unknown>): void => {
    log('debug', botId ?? null, msg, extra)
    if (!diagLogPath) return
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      process: processLabel,
      msg,
    }
    if (botId) entry.botId = botId
    if (extra) Object.assign(entry, extra)
    try {
      appendFileSync(diagLogPath, JSON.stringify(entry) + '\n', 'utf8')
    } catch {
      // ignore file write failures
    }
  },
}
