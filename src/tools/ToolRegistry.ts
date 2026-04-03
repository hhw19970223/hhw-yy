import type Anthropic from '@anthropic-ai/sdk'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ToolDef {
  /** Anthropic tool spec (name, description, input_schema). */
  spec: Anthropic.Tool
  /** Execute the tool with validated input, return a JSON string result. */
  execute(input: unknown): Promise<string>
}

// ─── Registry ────────────────────────────────────────────────────────────────

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>()

  register(def: ToolDef): void {
    this.tools.set(def.spec.name, def)
  }

  /** Return all tool specs in Anthropic API format. */
  getSpecs(): Anthropic.Tool[] {
    return Array.from(this.tools.values()).map((d) => d.spec)
  }

  /**
   * Execute a named tool. Returns a JSON string.
   * On unknown tool, returns an error string (never throws).
   */
  async execute(name: string, input: unknown): Promise<string> {
    const def = this.tools.get(name)
    if (!def) {
      return JSON.stringify({ error: `Unknown tool: ${name}` })
    }
    try {
      return await def.execute(input)
    } catch (err) {
      return JSON.stringify({ error: String(err) })
    }
  }
}
