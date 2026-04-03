import { appendFile, mkdir, readFile, writeFile } from 'fs/promises'
import { dirname } from 'path'

export interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

/**
 * In-memory conversation history with optional JSONL persistence.
 *
 * Persistence format: one JSON object per line (JSONL / ndjson).
 * - Appends are O(1) — no full rewrite on each turn.
 * - Compaction rewrites the file once when history is compressed.
 *
 * Inspired by claude-code's sessionStorage append-only JSONL transcript design.
 */
export class ConversationStore {
  private store = new Map<string, ConversationTurn[]>()

  constructor(
    private readonly historyLimit: number,
    private readonly persistPath?: (chatId: string) => string,
  ) {}

  get(chatId: string): ConversationTurn[] {
    return this.store.get(chatId) ?? []
  }

  append(chatId: string, userContent: string, assistantContent: string): void {
    const history = this.store.get(chatId) ?? []
    const now = new Date().toISOString()
    const userTurn: ConversationTurn = { role: 'user', content: userContent, timestamp: now }
    const asstTurn: ConversationTurn = { role: 'assistant', content: assistantContent, timestamp: now }

    history.push(userTurn, asstTurn)

    // Hard cap: drop oldest pairs when limit is reached
    if (history.length > this.historyLimit * 2) {
      history.splice(0, history.length - this.historyLimit * 2)
    }
    this.store.set(chatId, history)

    if (this.persistPath) {
      this.persistAppend(chatId, userTurn, asstTurn).catch(() => undefined)
    }
  }

  /**
   * Auto-compact: when history is ≥ 80% full, summarize the oldest half into a
   * single context-anchor pair, then rewrite the JSONL file.
   *
   * Inspired by claude-code's SessionMemory compaction (autocompact) pattern.
   * Call fire-and-forget after each append so it never blocks the reply path.
   */
  async compactIfNeeded(
    chatId: string,
    summarizeFn: (turns: ConversationTurn[]) => Promise<string>,
  ): Promise<void> {
    const history = this.store.get(chatId)
    if (!history) return

    const threshold = Math.floor(this.historyLimit * 2 * 0.8)
    if (history.length < threshold) return

    const halfPoint = Math.floor(history.length / 2)
    const toSummarize = history.slice(0, halfPoint)
    const toKeep = history.slice(halfPoint)

    try {
      const summary = await summarizeFn(toSummarize)
      const now = new Date().toISOString()

      // A valid turn-pair that anchors older context without breaking role alternation
      const summaryPair: ConversationTurn[] = [
        {
          role: 'user',
          content: `[Earlier conversation summary] ${summary}`,
          timestamp: now,
        },
        {
          role: 'assistant',
          content: 'Understood, I have the full context from our earlier conversation.',
          timestamp: now,
        },
      ]

      const compacted = [...summaryPair, ...toKeep]
      this.store.set(chatId, compacted)

      if (this.persistPath) {
        await this.persistFull(chatId, compacted)
      }
    } catch {
      // Compaction failed — leave history intact, it will be hard-capped on next append
    }
  }

  clear(chatId: string): void {
    this.store.delete(chatId)
  }

  stats(): { totalChats: number; totalTurns: number } {
    let totalTurns = 0
    for (const turns of this.store.values()) totalTurns += turns.length
    return { totalChats: this.store.size, totalTurns }
  }

  async loadFromDisk(chatId: string): Promise<void> {
    if (!this.persistPath) return
    const path = this.persistPath(chatId)
    try {
      const raw = await readFile(path, 'utf8')
      const turns = raw
        .trim()
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as ConversationTurn)
      // Enforce historyLimit on load
      this.store.set(chatId, turns.slice(-this.historyLimit * 2))
    } catch {
      // File not found or unreadable — start fresh
    }
  }

  /** Append two new turns as JSONL lines — O(1), no full rewrite. */
  private async persistAppend(
    chatId: string,
    userTurn: ConversationTurn,
    asstTurn: ConversationTurn,
  ): Promise<void> {
    const path = this.persistPath!(chatId)
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, JSON.stringify(userTurn) + '\n' + JSON.stringify(asstTurn) + '\n', 'utf8')
  }

  /** Rewrite the full JSONL file — used only after compaction. */
  private async persistFull(chatId: string, turns: ConversationTurn[]): Promise<void> {
    const path = this.persistPath!(chatId)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, turns.map((t) => JSON.stringify(t)).join('\n') + '\n', 'utf8')
  }
}
