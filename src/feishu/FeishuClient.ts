import * as lark from '@larksuiteoapi/node-sdk'
import { logger } from '../shared/logger.js'

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * A parsed Feishu @mention.
 * `key` is the literal placeholder in text messages (e.g. "@_user_1", "@_all").
 */
export interface MentionInfo {
  /** Literal placeholder in text content, e.g. "@_user_1" or "@_all" */
  key: string
  openId: string
  name: string
  /** True when this is @所有人 / @all */
  isAll: boolean
}

export interface FeishuMessage {
  messageId: string
  chatId: string
  chatType: 'p2p' | 'group'
  senderId: string
  senderType: string
  messageType: string
  /** Clean text — mention placeholders already stripped */
  text: string
  mentions: MentionInfo[]
  rootId?: string
  /** Parent message ID (for threaded replies) */
  parentId?: string
  /** Thread ID (to post into an existing thread) */
  threadId?: string
}

export type MessageEventHandler = (msg: FeishuMessage) => void

// ─── Client ───────────────────────────────────────────────────────────────────

export class FeishuClient {
  readonly client: lark.Client
  private wsClient: lark.WSClient
  private eventDispatcher: lark.EventDispatcher
  private botOpenId: string | null = null
  private messageHandler: MessageEventHandler | null = null
  /** Deduplication: track last 500 processed message IDs */
  private seenMessages = new Set<string>()

  constructor(
    private readonly botId: string,
    private readonly config: {
      appId: string
      appSecret: string
      encryptKey?: string
      verificationToken?: string
    },
  ) {
    this.client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: lark.Domain.Feishu,
    })

    this.eventDispatcher = new lark.EventDispatcher({
      encryptKey: config.encryptKey ?? '',
      verificationToken: config.verificationToken ?? '',
    }).register({
      'im.message.receive_v1': async (data: unknown) => {
        this.handleMessageEvent(data as FeishuRawEvent)
      },
    })

    this.wsClient = new lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
    })
  }

  async connect(): Promise<void> {
    await this.wsClient.start({ eventDispatcher: this.eventDispatcher })
    logger.info('Connected to Feishu WebSocket', this.botId)
  }

  /**
   * Fetch this bot's own open_id from the Feishu bot info API.
   * Required for self-message filtering and @mention detection.
   */
  async getBotOpenId(): Promise<string | null> {
    if (this.botOpenId) return this.botOpenId
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await (this.client as any).request({
        url: '/open-apis/bot/v3/info',
        method: 'GET',
      })
      // client.request returns the parsed body directly: { bot: {...}, code: 0, msg: "ok" }
      const openId = res?.bot?.open_id
      if (typeof openId === 'string' && openId) {
        this.botOpenId = openId
        logger.info(`Resolved bot open_id: ${openId}`, this.botId)
        return openId
      }
      logger.warn('Bot info API returned no open_id', this.botId)
    } catch (err) {
      logger.warn(`Could not fetch bot open_id: ${err}`, this.botId)
    }
    return null
  }

  onMessage(handler: MessageEventHandler): void {
    this.messageHandler = handler
  }

  async disconnect(): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.wsClient as any).close?.()
    } catch {
      // ignore
    }
    logger.info('Disconnected from Feishu WebSocket', this.botId)
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private handleMessageEvent(event: FeishuRawEvent): void {
    if (!this.messageHandler) return
    const messageId = event.message?.message_id
    if (!messageId) return

    // Deduplication — WebSocket can deliver the same event more than once
    if (this.isDuplicate(messageId)) {
      logger.debug(`Dropping duplicate message ${messageId}`, this.botId)
      return
    }

    try {
      const msg = this.parseEvent(event)
      if (msg) this.messageHandler(msg)
    } catch (err) {
      logger.error(`Failed to parse Feishu event: ${err}`, this.botId)
    }
  }

  private isDuplicate(messageId: string): boolean {
    if (this.seenMessages.has(messageId)) return true
    this.seenMessages.add(messageId)
    // Keep memory bounded — remove oldest entry when over 500
    if (this.seenMessages.size > 500) {
      const oldest = this.seenMessages.values().next().value as string
      this.seenMessages.delete(oldest)
    }
    return false
  }

  private parseEvent(event: FeishuRawEvent): FeishuMessage | null {
    const message = event.message
    if (!message) return null

    // Build mention list from the event-level mentions array
    const mentions: MentionInfo[] = (message.mentions ?? []).map((m: FeishuMention) => ({
      key: m.key ?? '',
      openId: m.id?.open_id ?? '',
      name: m.name ?? '',
      isAll: m.key === '@_all',
    }))

    // Extract clean text based on message type
    const text = this.extractText(message.message_type ?? 'text', message.content ?? '{}', mentions)

    return {
      messageId: message.message_id ?? '',
      chatId: message.chat_id ?? '',
      chatType: (message.chat_type ?? 'p2p') as 'p2p' | 'group',
      senderId: event.sender?.sender_id?.open_id ?? '',
      senderType: event.sender?.sender_type ?? 'user',
      messageType: message.message_type ?? 'text',
      text,
      mentions,
      rootId: message.root_id,
      parentId: message.parent_id,
      threadId: message.thread_id,
    }
  }

  /**
   * Extract a clean, plain text representation from the raw Feishu message content.
   *
   * - `text`:  `{"text": "Hello @_user_1!"}` → strip mention keys → `"Hello!"`
   * - `post`:  `{"zh_cn": {"content": [[{tag, text/href/...}]]}}` → extract text nodes
   * - others: best-effort JSON stringify
   */
  private extractText(messageType: string, rawContent: string, mentions: MentionInfo[]): string {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(rawContent) as Record<string, unknown>
    } catch {
      return rawContent.trim()
    }

    switch (messageType) {
      case 'text': {
        let text = (parsed['text'] as string) ?? ''
        // Strip all @key placeholders (e.g. "@_user_1", "@_all")
        for (const m of mentions) {
          if (m.key) text = text.replaceAll(m.key, '')
        }
        return text.trim()
      }

      case 'post': {
        return extractPostText(parsed)
      }

      default:
        // For image/file/audio/etc — return a human-readable placeholder
        return `[${messageType}]`
    }
  }
}

// ─── Post content extraction ─────────────────────────────────────────────────

/**
 * Recursively extract plain text from Feishu's "post" rich-text format.
 * Format: `{ zh_cn: { title: "...", content: [[ {tag, text|href|user_id}, ... ]] } }`
 * `at` nodes are skipped (they're @mentions, already in msg.mentions).
 */
function extractPostText(content: Record<string, unknown>): string {
  // Prefer zh_cn, fall back to en_us, then any locale
  const locale = (
    content['zh_cn'] ??
    content['en_us'] ??
    content[Object.keys(content)[0] ?? '']
  ) as Record<string, unknown> | undefined

  if (!locale) return ''

  const paragraphs = (locale['content'] as unknown[][] | undefined) ?? []
  const lines: string[] = []

  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) continue
    const parts: string[] = []
    for (const node of paragraph) {
      const n = node as Record<string, unknown>
      switch (n['tag']) {
        case 'text':
          parts.push(String(n['text'] ?? ''))
          break
        case 'a':
          // Link: prefer display text, fall back to href
          parts.push(String(n['text'] ?? n['href'] ?? ''))
          break
        case 'at':
          // @mention node — skip (already in mentions array)
          break
        // code_block, hr, img — skip or placeholder
      }
    }
    const line = parts.join('').trim()
    if (line) lines.push(line)
  }

  return lines.join('\n').trim()
}

// ─── Raw event types ─────────────────────────────────────────────────────────

interface FeishuRawEvent {
  sender?: {
    sender_id?: { open_id?: string; user_id?: string; union_id?: string }
    sender_type?: string
    tenant_key?: string
  }
  message?: {
    message_id?: string
    root_id?: string
    /** ID of the message this message replies to (threading) */
    parent_id?: string
    /** Thread ID for existing conversation threads */
    thread_id?: string
    chat_id?: string
    chat_type?: string
    message_type?: string
    content?: string
    mentions?: FeishuMention[]
  }
}

interface FeishuMention {
  /** Placeholder key used in text content, e.g. "@_user_1" or "@_all" */
  key?: string
  id?: { open_id?: string; user_id?: string; union_id?: string }
  name?: string
  tenant_key?: string
}
