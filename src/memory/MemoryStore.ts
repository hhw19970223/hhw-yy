import { readFile, writeFile, mkdir, readdir } from 'fs/promises'
import { join } from 'path'

function todayStr(): string {
  return new Date().toISOString().slice(0, 10) // YYYY-MM-DD
}

/**
 * Markdown daily-note memory for a bot.
 *
 * Storage: agents/{botId}/memory/
 *   YYYY-MM-DD.md  — one file per day
 *
 * "Current record"  = today's file (in-memory, flushed on save)
 * "Historical records" = older dated files (read-only at load time)
 */
export class MemoryStore {
  private dir = ''
  private _today = ''
  private _todayContent = ''

  /** Load today's note from the given directory. Creates dir if missing. */
  async load(dir: string): Promise<void> {
    this.dir = dir
    this._today = todayStr()
    await mkdir(dir, { recursive: true })

    try {
      this._todayContent = await readFile(join(dir, `${this._today}.md`), 'utf8')
    } catch {
      this._todayContent = `# ${this._today}\n`
    }
  }

  /** Append a timestamped note to today's in-memory content. */
  append(text: string): void {
    const time = new Date().toISOString().slice(11, 19) // HH:MM:SS
    this._todayContent += `\n## ${time}\n\n${text.trim()}\n`
  }

  /** Flush today's content to disk. */
  async save(): Promise<void> {
    if (!this.dir) return
    await writeFile(join(this.dir, `${this._today}.md`), this._todayContent, 'utf8')
  }

  /** Return today's in-memory note content. */
  today(): string {
    return this._todayContent
  }

  /**
   * Read the most recent N historical days (excluding today), sorted ascending.
   * Returns concatenated markdown sections separated by horizontal rules.
   */
  async recent(days: number): Promise<string> {
    if (!this.dir) return ''

    let files: string[] = []
    try {
      files = await readdir(this.dir)
    } catch {
      return ''
    }

    const historical = files
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f) && f !== `${this._today}.md`)
      .sort()
      .slice(-days)

    const sections: string[] = []
    for (const filename of historical) {
      try {
        const content = await readFile(join(this.dir, filename), 'utf8')
        if (content.trim()) sections.push(content.trim())
      } catch {
        // unreadable — skip
      }
    }
    return sections.join('\n\n---\n\n')
  }

  stats(): { dir: string; date: string; lines: number } {
    return {
      dir: this.dir,
      date: this._today,
      lines: this._todayContent.split('\n').length,
    }
  }
}
