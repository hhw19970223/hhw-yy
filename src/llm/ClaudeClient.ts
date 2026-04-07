import Anthropic from '@anthropic-ai/sdk'
import { ClaudeError } from '../shared/errors.js'
import type { ConversationTurn } from '../session/ConversationStore.js'
import type { ToolRegistry } from '../tools/ToolRegistry.js'

const MAX_TOOL_ITERATIONS = 10

export class ClaudeClient {
  private client: Anthropic

  constructor(
    private readonly config: {
      apiKey: string
      baseUrl?: string
      model: string
      systemPrompt: string
      maxTokens: number
      tools?: ToolRegistry
    },
  ) {
    this.client = new Anthropic({ apiKey: config.apiKey, ...(config.baseUrl ? { baseURL: config.baseUrl } : {}) })
  }

  /**
   * Non-streaming chat — used for injected messages and summarization.
   */
  async chat(history: ConversationTurn[], userMessage: string): Promise<{ text: string; tokensUsed: number }> {
    const messages = this.buildMessages(history, userMessage)
    const response = await this.callWithRetry(messages)
    const text = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('')
    const tokensUsed = (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0)
    return { text, tokensUsed }
  }

  /**
   * Streaming chat — calls onChunk with each text delta as it arrives.
   *
   * When tools are registered, runs a full agentic loop: after each tool_use
   * stop, executes all requested tools and feeds results back until end_turn
   * or MAX_TOOL_ITERATIONS is reached.
   *
   * Retries on rate-limit / overload with exponential backoff.
   */
  async chatStream(
    history: ConversationTurn[],
    userMessage: string,
    onChunk: (text: string) => void,
    attempt = 0,
    extraSystemContext?: string,
    onToolStart?: (toolName: string, inputSummary: string, claudeReasoning: string) => void,
  ): Promise<{ tokensUsed: number }> {
    const system = extraSystemContext
      ? `${this.config.systemPrompt}\n\n${extraSystemContext}`
      : this.config.systemPrompt
    const tools = this.config.tools?.getSpecs()

    // ── Non-tool path (unchanged behavior) ───────────────────────────────────
    if (!tools?.length) {
      const messages = this.buildMessages(history, userMessage)
      try {
        const stream = this.client.messages.stream({
          model: this.config.model,
          max_tokens: this.config.maxTokens,
          system,
          messages,
        })
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            onChunk(event.delta.text)
          }
        }
        const final = await stream.finalMessage()
        return { tokensUsed: (final.usage?.input_tokens ?? 0) + (final.usage?.output_tokens ?? 0) }
      } catch (err) {
        return this.handleStreamError(err, () =>
          this.chatStream(history, userMessage, onChunk, attempt + 1, extraSystemContext),
          attempt,
        )
      }
    }

    // ── Agentic loop ──────────────────────────────────────────────────────────
    let allMessages: Anthropic.MessageParam[] = this.buildMessages(history, userMessage)
    let totalTokens = 0

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      let iteration: {
        stopReason: string
        assistantContent: Anthropic.ContentBlock[]
        toolCalls: Array<{ id: string; name: string; input: unknown }>
        tokens: number
      }
      try {
        iteration = await this.streamIteration(allMessages, system, tools, onChunk)
      } catch (err) {
        return this.handleStreamError(err, () =>
          this.chatStream(history, userMessage, onChunk, attempt + 1, extraSystemContext, onToolStart),
          attempt,
        )
      }

      totalTokens += iteration.tokens

      if (iteration.stopReason !== 'tool_use') break

      // Notify caller before tool execution so it can send a progress message.
      // Include Claude's reasoning text from this iteration (what it said before
      // deciding to call the tools) so the caller can show meaningful progress.
      if (onToolStart) {
        const claudeReasoning = iteration.assistantContent
          .filter((c): c is Anthropic.TextBlock => c.type === 'text')
          .map((c) => c.text)
          .join('')
          .trim()
        for (const tc of iteration.toolCalls) {
          onToolStart(tc.name, summarizeInput(tc.input), claudeReasoning)
        }
      }

      // Execute all tool calls and collect results
      const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
        iteration.toolCalls.map(async (tc) => ({
          type: 'tool_result' as const,
          tool_use_id: tc.id,
          content: await this.config.tools!.execute(tc.name, tc.input),
        })),
      )

      allMessages = [
        ...allMessages,
        { role: 'assistant', content: iteration.assistantContent },
        { role: 'user', content: toolResults },
      ]
    }

    return { tokensUsed: totalTokens }
  }

  /**
   * Run one streaming iteration. Collects text deltas via onChunk, accumulates
   * tool_use blocks, and returns the full assistant content + stop_reason.
   */
  private async streamIteration(
    messages: Anthropic.MessageParam[],
    system: string,
    tools: Anthropic.Tool[],
    onChunk: (text: string) => void,
  ): Promise<{
    stopReason: string
    assistantContent: Anthropic.ContentBlock[]
    toolCalls: Array<{ id: string; name: string; input: unknown }>
    tokens: number
  }> {
    const stream = this.client.messages.stream({
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      system,
      tools,
      messages,
    })

    // Track in-progress tool_use blocks by index
    const toolJsonBuffers = new Map<number, { id: string; name: string; json: string }>()

    for await (const event of stream) {
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        toolJsonBuffers.set(event.index, {
          id: event.content_block.id,
          name: event.content_block.name,
          json: '',
        })
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          onChunk(event.delta.text)
        } else if (event.delta.type === 'input_json_delta') {
          const buf = toolJsonBuffers.get(event.index)
          if (buf) buf.json += event.delta.partial_json
        }
      }
    }

    const final = await stream.finalMessage()
    const tokens = (final.usage?.input_tokens ?? 0) + (final.usage?.output_tokens ?? 0)

    const toolCalls = Array.from(toolJsonBuffers.values()).map((buf) => ({
      id: buf.id,
      name: buf.name,
      input: (() => {
        try { return JSON.parse(buf.json) } catch { return {} }
      })(),
    }))

    return {
      stopReason: final.stop_reason ?? 'end_turn',
      assistantContent: final.content,
      toolCalls,
      tokens,
    }
  }

  private async handleStreamError(
    err: unknown,
    retry: () => Promise<{ tokensUsed: number }>,
    attempt: number,
  ): Promise<{ tokensUsed: number }> {
    const isRateLimit = err instanceof Anthropic.RateLimitError
    const isOverload = err instanceof Anthropic.APIError && err.status === 529
    const isTransient = err instanceof Anthropic.APIError && [404, 502, 503].includes(err.status)
    const maxAttempts = isTransient ? 5 : 3
    if ((isRateLimit || isOverload || isTransient) && attempt < maxAttempts) {
      await sleep(Math.pow(2, attempt) * 1000)
      return retry()
    }
    if (err instanceof Anthropic.APIError) {
      throw new ClaudeError(err.message, String(err.status), isRateLimit || isOverload)
    }
    throw new ClaudeError(String(err))
  }

  /**
   * Extract memorable facts from a single conversation exchange.
   *
   * Inspired by claude-code's SessionMemory post-sampling extraction and
   * openclaw's daily-note writing convention. Uses a lightweight non-streaming
   * call with no system prompt to keep it cheap. Returns null when the model
   * decides nothing is worth remembering (sentinel "SKIP").
   *
   * Always called fire-and-forget — never awaited in the reply path.
   */
  async extractMemory(userMessage: string, reply: string): Promise<string | null> {
    try {
      const response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: 256,
        messages: [
          {
            role: 'user',
            content:
              `Extract facts worth remembering from this exchange.\n\n` +
              `User: ${userMessage.slice(0, 800)}\n\nAssistant: ${reply.slice(0, 800)}\n\n` +
              `Rules:\n` +
              `- At most 3 concise bullet points\n` +
              `- Only durable facts: user preferences, decisions, key context\n` +
              `- Skip anything obvious or inferable from the conversation itself\n` +
              `- If nothing is worth remembering, output exactly: SKIP`,
          },
        ],
      })
      const text = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === 'text')
        .map((c) => c.text)
        .join('')
        .trim()
      return text === 'SKIP' || text === '' ? null : text
    } catch {
      return null
    }
  }

  /**
   * Summarize a list of conversation turns into a compact text.
   * Called by ConversationStore.compactIfNeeded — inspired by claude-code's
   * SessionMemory forked-subagent summarization pattern.
   */
  async summarize(turns: ConversationTurn[]): Promise<string> {
    const text = turns
      .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
      .join('\n\n')
    const response = await this.callWithRetry([
      {
        role: 'user',
        content: `Summarize the following conversation concisely, preserving all key facts, decisions, and context:\n\n${text}`,
      },
    ])
    return response.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('')
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private buildMessages(
    history: ConversationTurn[],
    userMessage: string,
  ): Anthropic.MessageParam[] {
    return [
      ...history.map((t) => ({ role: t.role, content: t.content }) as Anthropic.MessageParam),
      { role: 'user', content: userMessage },
    ]
  }

  private async callWithRetry(
    messages: Anthropic.MessageParam[],
    attempt = 0,
  ): Promise<Anthropic.Message> {
    try {
      return await this.client.messages.create({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        system: this.config.systemPrompt,
        messages,
      })
    } catch (err) {
      const isRateLimit = err instanceof Anthropic.RateLimitError
      const isOverload = err instanceof Anthropic.APIError && err.status === 529
      const isTransient = err instanceof Anthropic.APIError && [404, 502, 503].includes(err.status)
      const maxAttempts = isTransient ? 5 : 3
      if ((isRateLimit || isOverload || isTransient) && attempt < maxAttempts) {
        await sleep(Math.pow(2, attempt) * 1000)
        return this.callWithRetry(messages, attempt + 1)
      }
      if (err instanceof Anthropic.APIError) {
        throw new ClaudeError(err.message, String(err.status), isRateLimit || isOverload)
      }
      throw new ClaudeError(String(err))
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Produce a short human-readable summary of a tool's input object. */
function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return String(input ?? '').slice(0, 120)
  const obj = input as Record<string, unknown>
  // Prefer the most descriptive field
  const key = ['command', 'path', 'query', 'text', 'note', 'content'].find((k) => typeof obj[k] === 'string')
  if (key) return String(obj[key]).slice(0, 120)
  return JSON.stringify(obj).slice(0, 120)
}
