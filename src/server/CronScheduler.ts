import { randomUUID } from 'crypto'
import type { Manager } from '../process/Manager.js'
import { logger } from '../shared/logger.js'
import { WebStore, type StoredScheduledTask } from './WebStore.js'

interface CronSpec {
  minute: Set<number>
  hour: Set<number>
  dayOfMonth: Set<number>
  month: Set<number>
  dayOfWeek: Set<number>
}

export interface ParsedCronTask {
  cron: string
  prompt: string
  title: string
  nextRunAt: string
}

const CRON_RE = /(?:^|\bcron\s*[:=]?\s*)([0-9*,/\-]+)\s+([0-9*,/\-]+)\s+([0-9*,/\-]+)\s+([0-9*,/\-]+)\s+([0-9*,/\-]+)(?:\s+|$)/i

export function parseCronTask(text: string, now = new Date()): ParsedCronTask | null {
  const match = text.match(CRON_RE)
  if (!match) return null
  const cron = match.slice(1, 6).join(' ')
  const spec = parseCronSpec(cron)
  if (!spec) return null
  const prompt = text.slice((match.index ?? 0) + match[0].length).trim() || text.replace(match[0], '').trim()
  const title = prompt.replace(/\s+/g, ' ').slice(0, 48) || `定时任务 ${cron}`
  return {
    cron,
    prompt,
    title,
    nextRunAt: nextRunAt(spec, now).toISOString(),
  }
}

export function startCronScheduler(store: WebStore, manager: Manager): () => void {
  const run = () => {
    const due = store.listDueScheduledTasks()
    for (const task of due) runTask(store, manager, task)
  }
  const timer = setInterval(run, 30_000)
  run()
  return () => clearInterval(timer)
}

export function registerCronTask(store: WebStore, input: {
  chatId: string
  botIds: string[]
  text: string
}): StoredScheduledTask | null {
  const parsed = parseCronTask(input.text)
  if (!parsed) return null
  return store.createScheduledTask({
    id: randomUUID(),
    chatId: input.chatId,
    botIds: input.botIds,
    title: parsed.title,
    cron: parsed.cron,
    prompt: parsed.prompt,
    nextRunAt: parsed.nextRunAt,
  })
}

function runTask(store: WebStore, manager: Manager, task: StoredScheduledTask): void {
  const now = new Date()
  const spec = parseCronSpec(task.cron)
  if (!spec) {
    store.deleteScheduledTask(task.id)
    return
  }
  const triggerText = [
    `⏰ 定时任务触发：${task.title}`,
    `cron: ${task.cron}`,
    '',
    task.prompt,
  ].join('\n')

  store.addUserMessage({
    id: randomUUID(),
    chatId: task.chatId,
    userId: 'cron',
    authorName: 'Cron',
    text: triggerText,
  })

  for (const botId of task.botIds) {
    try {
      manager.sendWebMessage(botId, task.chatId, 'cron', triggerText)
    } catch (err) {
      logger.warn(`Scheduled task ${task.id} failed for ${botId}: ${err}`)
    }
  }

  store.updateScheduledTaskRun(task.id, now.toISOString(), nextRunAt(spec, now).toISOString())
}

function nextRunAt(spec: CronSpec, from: Date): Date {
  const cursor = new Date(from.getTime())
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)

  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (matches(spec, cursor)) return cursor
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  throw new Error('No matching cron time found within one year')
}

function matches(spec: CronSpec, date: Date): boolean {
  return spec.minute.has(date.getMinutes()) &&
    spec.hour.has(date.getHours()) &&
    spec.dayOfMonth.has(date.getDate()) &&
    spec.month.has(date.getMonth() + 1) &&
    spec.dayOfWeek.has(date.getDay())
}

function parseCronSpec(cron: string): CronSpec | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const minute = parseField(parts[0], 0, 59)
  const hour = parseField(parts[1], 0, 23)
  const dayOfMonth = parseField(parts[2], 1, 31)
  const month = parseField(parts[3], 1, 12)
  const dayOfWeek = parseField(parts[4], 0, 7, true)
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null
  return { minute, hour, dayOfMonth, month, dayOfWeek }
}

function parseField(raw: string, min: number, max: number, sundayAlias = false): Set<number> | null {
  const values = new Set<number>()
  for (const part of raw.split(',')) {
    const [rangePart, stepRaw] = part.split('/')
    const step = stepRaw ? Number(stepRaw) : 1
    if (!Number.isInteger(step) || step < 1) return null

    let start: number
    let end: number
    if (rangePart === '*') {
      start = min
      end = max
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map(Number)
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null
      start = a
      end = b
    } else {
      const value = Number(rangePart)
      if (!Number.isInteger(value)) return null
      start = value
      end = value
    }

    if (sundayAlias && rangePart !== '*' && start === 7) start = 0
    if (sundayAlias && rangePart !== '*' && end === 7) end = 0
    if (start < min || start > max || end < min || end > max) return null
    if (start <= end) {
      for (let value = start; value <= end; value += step) values.add(value)
    } else if (sundayAlias && start === 0 && end === 0) {
      values.add(0)
    } else {
      return null
    }
  }
  return values
}
