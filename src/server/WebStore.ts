import { execFileSync } from 'child_process'
import { mkdirSync } from 'fs'
import { dirname } from 'path'

export interface StoredConversation {
  botId: string
  chatId: string
  title: string
  kind: 'private' | 'group'
  members: string[]
  icon: string | null
  archived: boolean
  lastMessageAt: string
  lastSnippet: string
  unread: number
}

export interface StoredMessage {
  id: string
  conversationId: string
  role: 'user' | 'agent' | 'system'
  authorId: string
  authorName: string
  createdAt: string
  kind: string
  content: string
}

export interface StoredTask {
  id: string
  title: string
  owner: string
  state: 'queued' | 'running' | 'blocked' | 'done' | 'failed'
  updatedAt: string
}

export interface StoredToolLog {
  id: string
  time: string
  tool: string
  status: 'ok' | 'pending' | 'error'
}

export interface StoredScheduledTask {
  id: string
  chatId: string
  botIds: string[]
  title: string
  cron: string
  prompt: string
  nextRunAt: string
  lastRunAt: string | null
  createdAt: string
  enabled: boolean
}

function q(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function nowIso(): string {
  return new Date().toISOString()
}

function snippet(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 80)
}

function parseJsonRows<T>(raw: Buffer): T[] {
  const text = raw.toString('utf8').trim()
  return text ? JSON.parse(text) as T[] : []
}

export class WebStore {
  constructor(private readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS conversations (
        chat_id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        members_json TEXT NOT NULL DEFAULT '[]',
        icon TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        last_message_at TEXT NOT NULL,
        last_snippet TEXT NOT NULL DEFAULT '',
        unread INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, created_at, id);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        owner TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tool_logs (
        id TEXT PRIMARY KEY,
        time TEXT NOT NULL,
        tool TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        bot_ids_json TEXT NOT NULL,
        title TEXT NOT NULL,
        cron TEXT NOT NULL,
        prompt TEXT NOT NULL,
        next_run_at TEXT NOT NULL,
        last_run_at TEXT,
        created_at TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      );
    `)
    if (!this.hasColumn('conversations', 'members_json')) {
      this.exec(`ALTER TABLE conversations ADD COLUMN members_json TEXT NOT NULL DEFAULT '[]';`)
    }
    if (!this.hasColumn('conversations', 'archived')) {
      this.exec(`ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;`)
    }
    if (!this.hasColumn('conversations', 'icon')) {
      this.exec(`ALTER TABLE conversations ADD COLUMN icon TEXT;`)
    }
  }

  seedConversations(conversations: Array<{ botId: string; chatId: string; title: string; kind: 'private' | 'group'; members?: string[]; icon?: string | null }>): void {
    const timestamp = nowIso()
    for (const c of conversations) {
      const members = c.members ?? ['me', c.botId]
      this.exec(`
        INSERT INTO conversations (chat_id, bot_id, title, kind, members_json, icon, last_message_at, last_snippet, unread)
        VALUES (${q(c.chatId)}, ${q(c.botId)}, ${q(c.title)}, ${q(c.kind)}, ${q(JSON.stringify(members))}, ${q(c.icon ?? '')}, ${q(timestamp)}, '', 0)
        ON CONFLICT(chat_id) DO UPDATE SET
          bot_id = excluded.bot_id,
          title = excluded.title,
          kind = excluded.kind,
          members_json = CASE
            WHEN conversations.members_json = '[]' THEN excluded.members_json
            ELSE conversations.members_json
          END;
      `)
    }
  }

  createConversation(input: {
    chatId: string
    botId: string
    title: string
    kind: 'private' | 'group'
    members: string[]
    icon?: string | null
  }): StoredConversation {
    const timestamp = nowIso()
    this.exec(`
      INSERT INTO conversations (chat_id, bot_id, title, kind, members_json, icon, last_message_at, last_snippet, unread)
      VALUES (
        ${q(input.chatId)},
        ${q(input.botId)},
        ${q(input.title)},
        ${q(input.kind)},
        ${q(JSON.stringify(input.members))},
        ${q(input.icon ?? '')},
        ${q(timestamp)},
        '',
        0
      );
    `)
    return {
      botId: input.botId,
      chatId: input.chatId,
      title: input.title,
      kind: input.kind,
      members: input.members,
      icon: input.icon ?? null,
      lastMessageAt: timestamp,
      lastSnippet: '',
      unread: 0,
      archived: false,
    }
  }

  renameConversation(chatId: string, title: string): StoredConversation | null {
    const nextTitle = title.trim().slice(0, 80)
    if (!nextTitle) return null
    this.exec(`
      UPDATE conversations
      SET title = ${q(nextTitle)}
      WHERE chat_id = ${q(chatId)};
    `)
    return this.getConversation(chatId)
  }

  updateConversationIcon(chatId: string, icon: string): StoredConversation | null {
    this.exec(`
      UPDATE conversations
      SET icon = ${q(icon.trim().slice(0, 40))}
      WHERE chat_id = ${q(chatId)};
    `)
    return this.getConversation(chatId)
  }

  archiveConversation(chatId: string): StoredConversation | null {
    this.exec(`
      UPDATE conversations
      SET archived = 1
      WHERE chat_id = ${q(chatId)};
    `)
    return this.getConversation(chatId)
  }

  deleteConversation(chatId: string): boolean {
    const existing = this.getConversation(chatId)
    if (!existing) return false
    this.exec(`
      DELETE FROM messages WHERE chat_id = ${q(chatId)};
      DELETE FROM conversations WHERE chat_id = ${q(chatId)};
    `)
    return true
  }

  seedTasks(tasks: StoredTask[]): void {
    for (const task of tasks) {
      this.exec(`
        INSERT INTO tasks (id, title, owner, state, updated_at)
        VALUES (${q(task.id)}, ${q(task.title)}, ${q(task.owner)}, ${q(task.state)}, ${q(task.updatedAt)})
        ON CONFLICT(id) DO NOTHING;
      `)
    }
  }

  seedToolLogs(logs: StoredToolLog[]): void {
    for (const log of logs) {
      this.exec(`
        INSERT INTO tool_logs (id, time, tool, status)
        VALUES (${q(log.id)}, ${q(log.time)}, ${q(log.tool)}, ${q(log.status)})
        ON CONFLICT(id) DO NOTHING;
      `)
    }
  }

  listConversations(): StoredConversation[] {
    return this.query<{
      botId: string
      chatId: string
      title: string
      kind: 'private' | 'group'
      membersJson: string
      icon: string | null
      lastMessageAt: string
      lastSnippet: string
      unread: number
      archived: number
    }>(`
      SELECT
        bot_id AS botId,
        chat_id AS chatId,
        title,
        kind,
        members_json AS membersJson,
        icon,
        archived,
        last_message_at AS lastMessageAt,
        last_snippet AS lastSnippet,
        unread
      FROM conversations
      WHERE archived = 0
      ORDER BY datetime(last_message_at) DESC, title ASC;
    `).map((row) => ({
      botId: row.botId,
      chatId: row.chatId,
      title: row.title,
      kind: row.kind,
      members: parseMembers(row.membersJson, row.botId),
      icon: row.icon || null,
      archived: row.archived === 1,
      lastMessageAt: row.lastMessageAt,
      lastSnippet: row.lastSnippet,
      unread: row.unread,
    }))
  }

  listMessages(chatId: string): StoredMessage[] {
    return this.query<StoredMessage>(`
      SELECT
        id,
        chat_id AS conversationId,
        role,
        author_id AS authorId,
        author_name AS authorName,
        created_at AS createdAt,
        kind,
        content
      FROM messages
      WHERE chat_id = ${q(chatId)}
      ORDER BY datetime(created_at) ASC, id ASC;
    `)
  }

  listTasks(): StoredTask[] {
    return this.query<StoredTask>(`
      SELECT id, title, owner, state, updated_at AS updatedAt
      FROM tasks
      ORDER BY datetime(updated_at) DESC, id ASC;
    `)
  }

  listToolLogs(): StoredToolLog[] {
    return this.query<StoredToolLog>(`
      SELECT id, time, tool, status
      FROM tool_logs
      ORDER BY time DESC, id ASC
      LIMIT 50;
    `)
  }

  createScheduledTask(input: {
    id: string
    chatId: string
    botIds: string[]
    title: string
    cron: string
    prompt: string
    nextRunAt: string
  }): StoredScheduledTask {
    const createdAt = nowIso()
    this.exec(`
      INSERT INTO scheduled_tasks (id, chat_id, bot_ids_json, title, cron, prompt, next_run_at, last_run_at, created_at, enabled)
      VALUES (
        ${q(input.id)},
        ${q(input.chatId)},
        ${q(JSON.stringify(input.botIds))},
        ${q(input.title)},
        ${q(input.cron)},
        ${q(input.prompt)},
        ${q(input.nextRunAt)},
        NULL,
        ${q(createdAt)},
        1
      );
    `)
    return {
      id: input.id,
      chatId: input.chatId,
      botIds: input.botIds,
      title: input.title,
      cron: input.cron,
      prompt: input.prompt,
      nextRunAt: input.nextRunAt,
      lastRunAt: null,
      createdAt,
      enabled: true,
    }
  }

  listScheduledTasks(): StoredScheduledTask[] {
    return this.query<{
      id: string
      chatId: string
      botIdsJson: string
      title: string
      cron: string
      prompt: string
      nextRunAt: string
      lastRunAt: string | null
      createdAt: string
      enabled: number
    }>(`
      SELECT
        id,
        chat_id AS chatId,
        bot_ids_json AS botIdsJson,
        title,
        cron,
        prompt,
        next_run_at AS nextRunAt,
        last_run_at AS lastRunAt,
        created_at AS createdAt,
        enabled
      FROM scheduled_tasks
      WHERE enabled = 1
      ORDER BY datetime(next_run_at) ASC, datetime(created_at) DESC;
    `).map((row) => ({
      id: row.id,
      chatId: row.chatId,
      botIds: parseStringArray(row.botIdsJson),
      title: row.title,
      cron: row.cron,
      prompt: row.prompt,
      nextRunAt: row.nextRunAt,
      lastRunAt: row.lastRunAt,
      createdAt: row.createdAt,
      enabled: row.enabled === 1,
    }))
  }

  listDueScheduledTasks(now = nowIso()): StoredScheduledTask[] {
    return this.query<{
      id: string
      chatId: string
      botIdsJson: string
      title: string
      cron: string
      prompt: string
      nextRunAt: string
      lastRunAt: string | null
      createdAt: string
      enabled: number
    }>(`
      SELECT
        id,
        chat_id AS chatId,
        bot_ids_json AS botIdsJson,
        title,
        cron,
        prompt,
        next_run_at AS nextRunAt,
        last_run_at AS lastRunAt,
        created_at AS createdAt,
        enabled
      FROM scheduled_tasks
      WHERE enabled = 1 AND datetime(next_run_at) <= datetime(${q(now)})
      ORDER BY datetime(next_run_at) ASC;
    `).map((row) => ({
      id: row.id,
      chatId: row.chatId,
      botIds: parseStringArray(row.botIdsJson),
      title: row.title,
      cron: row.cron,
      prompt: row.prompt,
      nextRunAt: row.nextRunAt,
      lastRunAt: row.lastRunAt,
      createdAt: row.createdAt,
      enabled: row.enabled === 1,
    }))
  }

  updateScheduledTaskRun(id: string, lastRunAt: string, nextRunAt: string): void {
    this.exec(`
      UPDATE scheduled_tasks
      SET last_run_at = ${q(lastRunAt)},
          next_run_at = ${q(nextRunAt)}
      WHERE id = ${q(id)};
    `)
  }

  deleteScheduledTask(id: string): boolean {
    const before = this.query<{ id: string }>(`SELECT id FROM scheduled_tasks WHERE id = ${q(id)} LIMIT 1;`)
    if (before.length === 0) return false
    this.exec(`DELETE FROM scheduled_tasks WHERE id = ${q(id)};`)
    return true
  }

  getConversationBot(chatId: string): string | null {
    const rows = this.query<{ botId: string }>(`
      SELECT bot_id AS botId FROM conversations WHERE chat_id = ${q(chatId)} LIMIT 1;
    `)
    return rows[0]?.botId ?? null
  }

  getConversation(chatId: string): StoredConversation | null {
    const rows = this.query<{
      botId: string
      chatId: string
      title: string
      kind: 'private' | 'group'
      membersJson: string
      icon: string | null
      lastMessageAt: string
      lastSnippet: string
      unread: number
      archived: number
    }>(`
      SELECT
        bot_id AS botId,
        chat_id AS chatId,
        title,
        kind,
        members_json AS membersJson,
        icon,
        archived,
        last_message_at AS lastMessageAt,
        last_snippet AS lastSnippet,
        unread
      FROM conversations
      WHERE chat_id = ${q(chatId)}
      LIMIT 1;
    `)
    const row = rows[0]
    if (!row) return null
    return {
      botId: row.botId,
      chatId: row.chatId,
      title: row.title,
      kind: row.kind,
      members: parseMembers(row.membersJson, row.botId),
      icon: row.icon || null,
      archived: row.archived === 1,
      lastMessageAt: row.lastMessageAt,
      lastSnippet: row.lastSnippet,
      unread: row.unread,
    }
  }

  addUserMessage(input: { id: string; chatId: string; userId: string; authorName: string; text: string }): void {
    const createdAt = nowIso()
    this.upsertMessage({
      id: input.id,
      conversationId: input.chatId,
      role: 'user',
      authorId: input.userId,
      authorName: input.authorName,
      createdAt,
      kind: 'text',
      content: input.text,
    })
    this.updateConversationPreview(input.chatId, createdAt, snippet(input.text), 0)
  }

  addAgentMessage(input: { id: string; chatId: string; botId: string; authorName: string; text: string }): void {
    const createdAt = nowIso()
    this.upsertMessage({
      id: input.id,
      conversationId: input.chatId,
      role: 'agent',
      authorId: input.botId,
      authorName: input.authorName,
      createdAt,
      kind: 'text',
      content: input.text,
    })
    this.updateConversationPreview(input.chatId, createdAt, snippet(input.text), 0)
  }

  upsertUiMessage(input: StoredMessage, preview?: string): void {
    this.upsertMessage(input)
    if (preview !== undefined) {
      this.updateConversationPreview(input.conversationId, input.createdAt, snippet(preview), 0)
    }
  }

  private upsertMessage(message: StoredMessage): void {
    this.exec(`
      INSERT INTO messages (id, chat_id, role, author_id, author_name, created_at, kind, content)
      VALUES (
        ${q(message.id)},
        ${q(message.conversationId)},
        ${q(message.role)},
        ${q(message.authorId)},
        ${q(message.authorName)},
        ${q(message.createdAt)},
        ${q(message.kind)},
        ${q(message.content)}
      )
      ON CONFLICT(id) DO UPDATE SET
        role = excluded.role,
        author_id = excluded.author_id,
        author_name = excluded.author_name,
        kind = excluded.kind,
        content = excluded.content,
        created_at = excluded.created_at;
    `)
  }

  private updateConversationPreview(chatId: string, lastMessageAt: string, lastSnippet: string, unread: number): void {
    this.exec(`
      UPDATE conversations
      SET last_message_at = ${q(lastMessageAt)},
          last_snippet = ${q(lastSnippet)},
          unread = ${unread}
      WHERE chat_id = ${q(chatId)};
    `)
  }

  private query<T>(sql: string): T[] {
    return parseJsonRows<T>(execFileSync('sqlite3', ['-json', this.dbPath, sql]))
  }

  private exec(sql: string, ignoreError = false): void {
    try {
      execFileSync('sqlite3', [this.dbPath, sql])
    } catch (err) {
      if (!ignoreError) throw err
    }
  }

  private hasColumn(table: string, column: string): boolean {
    return this.query<{ name: string }>(`PRAGMA table_info(${q(table)});`)
      .some((row) => row.name === column)
  }
}

function parseMembers(raw: string, botId: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed.length > 0 ? parsed : ['me', botId]
    }
  } catch {
    // fall through
  }
  return ['me', botId]
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed
  } catch {
    // fall through
  }
  return []
}
