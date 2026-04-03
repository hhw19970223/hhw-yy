import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname } from 'path'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MemoryEntry {
  key: string
  value: string
  scope: string
  createdAt: string
  updatedAt: string
  /** Unix timestamp (ms) after which this entry is considered expired */
  expiresAt?: number
}

/**
 * Scope format:
 *   bot:<botId>          — per-bot global memory
 *   chat:<chatId>        — per-conversation memory
 *   user:<userId>        — per-user memory across all chats
 *   global               — shared across all bots
 */
export type MemoryScope = `bot:${string}` | `chat:${string}` | `user:${string}` | 'global'

// ─── MemoryStore ─────────────────────────────────────────────────────────────

export class MemoryStore {
  private data = new Map<string, MemoryEntry>()

  private scopeKey(scope: string, key: string): string {
    return `${scope}::${key}`
  }

  /** Store a memory entry. Pass ttlSeconds to auto-expire it. */
  set(scope: MemoryScope, key: string, value: string, ttlSeconds?: number): void {
    const now = new Date().toISOString()
    const existing = this.data.get(this.scopeKey(scope, key))
    const entry: MemoryEntry = {
      key,
      value,
      scope,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
    }
    this.data.set(this.scopeKey(scope, key), entry)
  }

  /** Retrieve a memory value, returns null if missing or expired. */
  get(scope: MemoryScope, key: string): string | null {
    const entry = this.data.get(this.scopeKey(scope, key))
    if (!entry) return null
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.data.delete(this.scopeKey(scope, key))
      return null
    }
    return entry.value
  }

  /** Delete a specific memory entry. */
  delete(scope: MemoryScope, key: string): boolean {
    return this.data.delete(this.scopeKey(scope, key))
  }

  /** List all non-expired entries within a scope. */
  list(scope: MemoryScope): MemoryEntry[] {
    const now = Date.now()
    const results: MemoryEntry[] = []
    for (const entry of this.data.values()) {
      if (entry.scope !== scope) continue
      if (entry.expiresAt && now > entry.expiresAt) {
        this.data.delete(this.scopeKey(scope, entry.key))
        continue
      }
      results.push(entry)
    }
    return results
  }

  /** Search entries by value substring across all scopes. */
  search(query: string): MemoryEntry[] {
    const now = Date.now()
    const q = query.toLowerCase()
    const results: MemoryEntry[] = []
    for (const entry of this.data.values()) {
      if (entry.expiresAt && now > entry.expiresAt) continue
      if (entry.value.toLowerCase().includes(q) || entry.key.toLowerCase().includes(q)) {
        results.push(entry)
      }
    }
    return results
  }

  /** Remove all entries for a scope. */
  clear(scope: MemoryScope): void {
    for (const [compoundKey, entry] of this.data.entries()) {
      if (entry.scope === scope) this.data.delete(compoundKey)
    }
  }

  /** Purge all expired entries. */
  evictExpired(): number {
    const now = Date.now()
    let count = 0
    for (const [key, entry] of this.data.entries()) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this.data.delete(key)
        count++
      }
    }
    return count
  }

  /** Persist all entries to a JSON file. */
  async save(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const entries = Array.from(this.data.values())
    await writeFile(path, JSON.stringify(entries, null, 2), 'utf8')
  }

  /** Load entries from a JSON file (merges into existing data). */
  async load(path: string): Promise<void> {
    try {
      const raw = await readFile(path, 'utf8')
      const entries = JSON.parse(raw) as MemoryEntry[]
      const now = Date.now()
      for (const entry of entries) {
        if (entry.expiresAt && now > entry.expiresAt) continue
        this.data.set(this.scopeKey(entry.scope, entry.key), entry)
      }
    } catch {
      // File not found or invalid — start empty
    }
  }

  stats(): { total: number; scopes: Record<string, number> } {
    const scopes: Record<string, number> = {}
    for (const entry of this.data.values()) {
      scopes[entry.scope] = (scopes[entry.scope] ?? 0) + 1
    }
    return { total: this.data.size, scopes }
  }
}
