import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import type { ConversationTurn } from '../session/ConversationStore.js'
import { Paths } from '../config/paths.js'
import type { LlmClient } from './types.js'

interface ClaudeCodeStreamLine {
  type?: string
  event?: {
    type?: string
    delta?: {
      type?: string
      text?: string
    }
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
  result?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

export class ClaudeCodeClient implements LlmClient {
  private readonly sessionQueues = new Map<string, Promise<unknown>>()
  private readonly timeoutMs = Number(process.env.SL_CLAUDE_CODE_TIMEOUT_MS ?? 480_000)

  constructor(
    private readonly config: {
      botId: string
      model?: string
      systemPrompt: string
      httpPort: number
      permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' | 'plan' | 'auto'
    },
  ) {}

  async chat(history: ConversationTurn[], userMessage: string): Promise<{ text: string; tokensUsed: number }> {
    const prompt = history.length > 0
      ? `${formatHistory(history)}\n\n当前用户消息：\n${userMessage}`
      : userMessage
    let text = ''
    const result = await this.runClaudeCode({
      prompt,
      sessionKey: `${this.config.botId}:adhoc:${Date.now()}`,
      noSession: true,
      onChunk: (chunk) => { text += chunk },
    })
    return { text: text || result.text, tokensUsed: result.tokensUsed }
  }

  async chatStream(
    history: ConversationTurn[],
    userMessage: string,
    onChunk: (text: string) => void,
    _attempt = 0,
    extraSystemContext?: string,
    _onToolStart?: (toolName: string, inputSummary: string, claudeReasoning: string) => void,
    onLLMStart?: () => void,
  ): Promise<{ tokensUsed: number }> {
    onLLMStart?.()
    const chatId = extraSystemContext?.match(/chat_id:\s*([^\n]+)/)?.[1]?.trim() || 'default'
    const directSelf = Boolean(extraSystemContext?.includes('<web_group_direct_reply>'))
    const sessionKey = directSelf
      ? `${this.config.botId}:${chatId}:direct`
      : `${this.config.botId}:${chatId}`
    const systemPrompt = extraSystemContext
      ? `${this.config.systemPrompt}\n\n${extraSystemContext}`
      : this.config.systemPrompt

    const prompt = history.length > 0
      ? [
          '以下是当前 Web 任务的最近对话历史。请把它作为本轮上下文，尤其保留用户提到的文件、图片、路径、附件和已确认事项。',
          '',
          formatHistory(history.slice(-20)),
          '',
          '当前用户消息：',
          userMessage,
        ].join('\n')
      : userMessage

    const result = await this.runClaudeCode({
      prompt,
      sessionKey,
      systemPrompt,
      noSession: directSelf,
      onChunk,
    })
    return { tokensUsed: result.tokensUsed }
  }

  async extractMemory(userMessage: string, reply: string): Promise<string | null> {
    const prompt = [
      '从下面对话中提取值得长期记住的一条简短事实、用户偏好或待办。',
      '如果没有值得记录的信息，只输出 SKIP。',
      '',
      `用户：${userMessage}`,
      `助手：${reply}`,
    ].join('\n')
    const { text } = await this.chat([], prompt)
    const trimmed = text.trim()
    return !trimmed || trimmed === 'SKIP' ? null : trimmed
  }

  async summarize(turns: ConversationTurn[]): Promise<string> {
    const { text } = await this.chat([], `请用简体中文简要总结以下历史对话，保留事实、决策和待办：\n\n${formatHistory(turns)}`)
    return text.trim()
  }

  private async runClaudeCode(input: {
    prompt: string
    sessionKey: string
    systemPrompt?: string
    noSession?: boolean
    onChunk: (text: string) => void
  }): Promise<{ text: string; tokensUsed: number }> {
    const sessionId = stableUuid(input.sessionKey)
    return this.withSessionLock(sessionId, () => this.runClaudeCodeLocked(input, sessionId))
  }

  private async runClaudeCodeLocked(input: {
    prompt: string
    sessionKey: string
    systemPrompt?: string
    noSession?: boolean
    onChunk: (text: string) => void
  }, sessionId: string): Promise<{ text: string; tokensUsed: number }> {
    const cwd = Paths.workspaceBot(this.config.botId)
    const systemPrompt = input.systemPrompt ?? this.config.systemPrompt
    const args = [
      '-p',
      '--verbose',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--permission-mode',
      this.config.permissionMode ?? 'bypassPermissions',
      '--system-prompt',
      systemPrompt,
      '--mcp-config',
      JSON.stringify(this.mcpConfig()),
      ...this.addDirArgs(),
    ]
    if (this.config.model) args.push('--model', this.config.model)
    if (input.noSession) {
      args.push('--no-session-persistence')
    } else {
      args.push('--resume', sessionId)
    }
    args.push(input.prompt)

    const first = await this.spawnClaudeWithRetry(args, cwd, input.onChunk)
    if (!input.noSession && first.noConversation) {
      const retryArgs = args.filter((arg, index) => !(arg === '--resume' || args[index - 1] === '--resume'))
      retryArgs.splice(retryArgs.length - 1, 0, '--session-id', sessionId)
      return this.spawnClaudeWithRetry(retryArgs, cwd, input.onChunk)
    }
    return first
  }

  private async withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const queueMarker = previous.then(() => current, () => current)
    this.sessionQueues.set(sessionId, queueMarker)
    await previous.catch(() => undefined)
    try {
      return await fn()
    } finally {
      release()
      if (this.sessionQueues.get(sessionId) === queueMarker) {
        this.sessionQueues.delete(sessionId)
      }
    }
  }

  private addDirArgs(): string[] {
    const dirs = [
      Paths.workspaceCommon,
      Paths.agentDir(this.config.botId),
      Paths.agentCommonDir,
      join(process.cwd(), 'public'),
    ].filter((dir) => existsSync(dir))
    return dirs.flatMap((dir) => ['--add-dir', dir])
  }

  private mcpConfig(): { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> } {
    return {
      mcpServers: {
        sl_agent_tools: {
          command: 'npx',
          args: ['tsx', resolve(process.cwd(), 'src/mcp/claudeCodeDelegateServer.ts')],
          env: {
            SL_BOT_ID: this.config.botId,
            SL_HTTP_PORT: String(this.config.httpPort),
          },
        },
      },
    }
  }

  private spawnClaude(
    args: string[],
    cwd: string,
    onChunk: (text: string) => void,
  ): Promise<{ text: string; tokensUsed: number; noConversation?: boolean }> {
    return new Promise((resolve, reject) => {
      const child = spawn('claude', args, { cwd, env: process.env })
      let stdout = ''
      let stderr = ''
      let lineBuffer = ''
      let resultText = ''
      let streamedText = ''
      let tokensUsed = 0
      let closed = false
      let timedOut = false
      const timeout = setTimeout(() => {
        if (closed) return
        timedOut = true
        child.kill('SIGTERM')
        setTimeout(() => {
          if (!closed) child.kill('SIGKILL')
        }, 3_000).unref()
      }, this.timeoutMs)
      timeout.unref()

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
        lineBuffer += chunk
        let newline = lineBuffer.indexOf('\n')
        while (newline >= 0) {
          const line = lineBuffer.slice(0, newline).trim()
          lineBuffer = lineBuffer.slice(newline + 1)
          if (line) {
            const parsed = parseLine(line)
            if (parsed) {
              const textDelta = parsed.event?.delta?.type === 'text_delta' ? parsed.event.delta.text ?? '' : ''
              if (textDelta) {
                streamedText += textDelta
                onChunk(textDelta)
              }
              if (parsed.type === 'result') {
                resultText = parsed.result ?? resultText
                tokensUsed = usageTokens(parsed)
              }
              if (parsed.event?.type === 'message_stop') {
                tokensUsed = usageTokens(parsed)
              }
            }
          }
          newline = lineBuffer.indexOf('\n')
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => { stderr += chunk })
      child.on('error', reject)
      child.on('close', (code) => {
        closed = true
        clearTimeout(timeout)
        const text = streamedText || resultText
        if (timedOut) {
          reject(new Error(`claude timed out after ${Math.round(this.timeoutMs / 1000)}s`))
          return
        }
        const noConversation = `${stdout}\n${stderr}`.includes('No conversation found with session ID')
        if (code !== 0 && !noConversation) {
          if (text.trim()) {
            resolve({ text, tokensUsed, noConversation })
            return
          }
          reject(new Error(`claude exited with code ${code}: ${stderr || stdout}`))
          return
        }
        if (!streamedText && resultText) onChunk(resultText)
        resolve({ text, tokensUsed, noConversation })
      })
    })
  }

  private async spawnClaudeWithRetry(
    args: string[],
    cwd: string,
    onChunk: (text: string) => void,
  ): Promise<{ text: string; tokensUsed: number; noConversation?: boolean }> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.spawnClaude(args, cwd, onChunk)
      } catch (err) {
        if (!isSessionBusyError(err)) throw err
        if (attempt === 4) {
          return this.spawnClaude(withoutSessionPersistence(args), cwd, onChunk)
        }
        await sleep(750 + attempt * 500)
      }
    }
    throw new Error('unreachable')
  }
}

function isSessionBusyError(err: unknown): boolean {
  return err instanceof Error && /Session ID .* is already in use/.test(err.message)
}

function withoutSessionPersistence(args: string[]): string[] {
  const next: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--resume' || arg === '--session-id') {
      index += 1
      continue
    }
    if (arg === '--no-session-persistence') continue
    next.push(arg)
  }
  next.splice(next.length - 1, 0, '--no-session-persistence')
  return next
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseLine(line: string): ClaudeCodeStreamLine | null {
  try {
    return JSON.parse(line) as ClaudeCodeStreamLine
  } catch {
    return null
  }
}

function usageTokens(line: ClaudeCodeStreamLine): number {
  const usage = line.usage ?? line.event?.usage
  return (usage?.input_tokens ?? 0) +
    (usage?.output_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0)
}

function stableUuid(value: string): string {
  const hash = createHash('sha256').update(value).digest('hex')
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `${(parseInt(hash.slice(16, 18), 16) & 0x3f | 0x80).toString(16).padStart(2, '0')}${hash.slice(18, 20)}`,
    hash.slice(20, 32),
  ].join('-')
}

function formatHistory(turns: ConversationTurn[]): string {
  return turns.map((turn) => `${turn.role === 'user' ? '用户' : '助手'}：${turn.content}`).join('\n\n')
}
