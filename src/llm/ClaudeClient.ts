import Anthropic from '@anthropic-ai/sdk'
import { ClaudeError } from '../shared/errors.js'
import type { ConversationTurn } from '../session/ConversationStore.js'

export class ClaudeClient {
  private client: Anthropic

  constructor(
    private readonly config: {
      apiKey: string
      baseUrl?: string
      model: string
      systemPrompt: string
      maxTokens: number
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
   * Inspired by claude-code QueryEngine's async-generator streaming loop:
   * text arrives in small deltas, callers accumulate and react in real time.
   * Retries on rate-limit / overload with exponential backoff.
   */
  async chatStream(
    history: ConversationTurn[],
    userMessage: string,
    onChunk: (text: string) => void,
    attempt = 0,
  ): Promise<{ tokensUsed: number }> {
    const messages = this.buildMessages(history, userMessage)
    try {
      const stream = this.client.messages.stream({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        system: this.config.systemPrompt,
        messages,
      })

      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          onChunk(event.delta.text)
        }
      }

      const final = await stream.finalMessage()
      const tokensUsed = (final.usage?.input_tokens ?? 0) + (final.usage?.output_tokens ?? 0)
      return { tokensUsed }
    } catch (err) {
      const isRateLimit = err instanceof Anthropic.RateLimitError
      const isOverload = err instanceof Anthropic.APIError && err.status === 529
      const isTransient = err instanceof Anthropic.APIError && [404, 502, 503].includes(err.status)
      const maxAttempts = isTransient ? 5 : 3
      if ((isRateLimit || isOverload || isTransient) && attempt < maxAttempts) {
        await sleep(Math.pow(2, attempt) * 1000)
        return this.chatStream(history, userMessage, onChunk, attempt + 1)
      }
      if (err instanceof Anthropic.APIError) {
        throw new ClaudeError(err.message, String(err.status), isRateLimit || isOverload)
      }
      throw new ClaudeError(String(err))
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
