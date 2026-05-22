import { randomUUID } from 'crypto'
import type { FeishuMessage, MentionInfo } from './FeishuClient.js'
import type { LlmClient } from '../llm/types.js'
import { ConversationStore } from '../session/ConversationStore.js'
import type { ConversationTurn } from '../session/ConversationStore.js'
import { MemoryStore } from '../memory/MemoryStore.js'
import type { FeishuSender } from './reply/Sender.js'
import { logger } from '../shared/logger.js'
import type { LoadedSubAgentConfig } from '../config/schema.js'
import type { UpwardMessage } from '../process/ipc/types.js'
import { buildWorkspaceContext } from '../workspace/WorkspaceManager.js'

export type IpcSend = (msg: UpwardMessage) => void

const SUPPORTED_MESSAGE_TYPES = new Set(['text', 'post'])

function formatCurrentTime(): string {
  const now = new Date()
  return `${now.toLocaleDateString('zh-CN')} ${now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
}

export class MessageHandler {
  private botOpenId: string | null = null

  constructor(
    private readonly botId: string,
    private readonly config: LoadedSubAgentConfig,
    private readonly claude: LlmClient,
    private readonly store: ConversationStore,
    private readonly sender: FeishuSender,
    private readonly ipcSend: IpcSend,
    private readonly memory?: MemoryStore,
  ) {}

  setBotOpenId(openId: string): void {
    this.botOpenId = openId
  }

  /**
   * Fire a typing reaction immediately when a message arrives — called BEFORE
   * the per-chatId queue so the user sees feedback even if the chat is busy.
   */
  acknowledge(msg: FeishuMessage): void {
    if (!this.config.behavior.typingIndicator) return
    // Only react in group chats when this bot is directly @mentioned
    if (msg.chatType === 'group') {
      if (!this.botOpenId) return
      const mentioned = msg.mentions.some((m) => m.openId === this.botOpenId && !m.isAll)
      if (!mentioned) return
    }
    this.randomReaction(msg.messageId)
  }

  private randomReaction(messageId: string): void {
    const reactions = ['PROUD', 'WITTY', 'SMART', 'SCOWL', 'ERROR']
    const reaction = reactions[Math.floor(Math.random() * reactions.length)]!
    this.sender.addReaction(messageId, reaction).catch(() => undefined)
  }

  async handle(msg: FeishuMessage): Promise<void> {
    logger.diag(`handle() called: msgId=${msg.messageId} chatId=${msg.chatId} senderId=${msg.senderId} senderType=${msg.senderType}`, this.botId)
    // Stage 1: Message type filter
    if (!SUPPORTED_MESSAGE_TYPES.has(msg.messageType)) return

    // Stage 2: Policy gate (includes @mention check)
    const gateResult = this.checkGate(msg)
    if (!gateResult.allowed) {
      if (gateResult.reason) logger.debug(gateResult.reason, this.botId)
      return
    }

    // Stage 3: Self-message filter
    if (this.botOpenId && msg.senderId === this.botOpenId) return
    // Guard: if botOpenId is not yet resolved, block all app-originated messages
    // to prevent the bot from responding to its own replies before open_id is known
    if (!this.botOpenId && msg.senderType === 'app') {
      logger.diag(`Blocking app message — botOpenId not yet resolved (senderId=${msg.senderId})`, this.botId)
      return
    }

    // Log incoming message
    const mentionStr = msg.mentions.length
      ? ` mentions=[${msg.mentions.map((m) => m.name).join(', ')}]`
      : ''
    logger.info(
      `Incoming ${msg.chatType} message | from=${msg.senderId}${mentionStr} | text="${msg.text}"`,
      this.botId,
    )

    const startTime = Date.now()
    // A unique id for this streaming reply so web subscribers can route chunks
    // into the correct placeholder bubble.
    const streamMessageId = randomUUID()

    this.ipcSend({
      type: 'MESSAGE_RECEIVED',
      botId: this.botId,
      chatId: msg.chatId,
      userId: msg.senderId,
      messageId: msg.messageId,
      textPreview: msg.text.slice(0, 100),
    })

    // Notify web subscribers that this bot started replying
    this.ipcSend({ type: 'WEB_TYPING', botId: this.botId, chatId: msg.chatId, on: true })

    // Hand heartbeat ownership to the main process (immune to worker event-loop starvation)
    this.ipcSend({ type: 'HEARTBEAT_START', chatId: msg.chatId, replyToMessageId: msg.messageId })
    logger.diag(`HEARTBEAT_START sent for chat=${msg.chatId}`, this.botId)

    try {
      // Stage 5: Build Claude input
      // msg.text is already clean (mention keys stripped by FeishuClient)
      const history = this.store.get(msg.chatId)

      // Stage 5a: Build system context — session info + workspace files
      // chat_id is always injected so agents can use it in delegate_to_agent calls
      // current_time is injected so agents can track elapsed time for progress reporting
      let extraSystemContext =
        `<current_session>\nchat_id: ${msg.chatId}\nsender_user_id: ${msg.senderId}\ncurrent_time: ${formatCurrentTime()}\n</current_session>`
      if (this.config.behavior.injectWorkspaceContext) {
        const workspaceCtx = await buildWorkspaceContext(this.botId).catch(() => undefined)
        if (workspaceCtx) extraSystemContext += '\n\n' + workspaceCtx
      }

      // Stage 6: Call Claude (streaming — accumulate deltas, same UX as before but
      // memory-efficient and unblocks retry logic per delta batch)
      let reply = ''
      const { tokensUsed } = await this.claude.chatStream(
        history,
        msg.text,
        (chunk) => {
          reply += chunk
          // Tee the chunk to web subscribers of this chatId
          this.ipcSend({
            type: 'WEB_REPLY_CHUNK',
            botId: this.botId,
            chatId: msg.chatId,
            messageId: streamMessageId,
            chunk,
          })
        },
        0,
        extraSystemContext,
        (toolName, inputSummary, claudeReasoning) => {
          logger.diag(`Tool starting: ${toolName}(${inputSummary.slice(0, 60)})`, this.botId)
          if (claudeReasoning) {
            this.ipcSend({ type: 'HEARTBEAT_UPDATE', chatId: msg.chatId, reasoning: claudeReasoning })
          }
        },
        () => { this.ipcSend({ type: 'HEARTBEAT_UPDATE', chatId: msg.chatId, reasoning: '正在生成回复...' }) },
      )

      // Stage 7: Update conversation store + reply
      this.store.append(msg.chatId, msg.text, reply)

      // Stage 7a: Auto-compact when history is nearing capacity (fire-and-forget)
      // Inspired by claude-code SessionMemory post-sampling compaction pattern
      this.store
        .compactIfNeeded(msg.chatId, (turns) => this.claude.summarize(turns))
        .catch(() => undefined)

      // Reply threads to the original message so Feishu notifies the sender
      const replyId = await this.sender.sendText(msg.chatId, msg.messageId, reply)

      const elapsedMs = Date.now() - startTime
      this.ipcSend({
        type: 'REPLY_SENT',
        botId: this.botId,
        chatId: msg.chatId,
        messageId: msg.messageId,
        replyId,
        tokensUsed,
        elapsedMs,
      })

      // Notify web subscribers that the reply is complete
      this.ipcSend({
        type: 'WEB_REPLY_DONE',
        botId: this.botId,
        chatId: msg.chatId,
        messageId: streamMessageId,
        tokensUsed,
        elapsedMs,
        fullText: reply,
      })

      logger.info(`Replied in ${elapsedMs}ms, ${tokensUsed} tokens`, this.botId)

      // Stage 8: Memory extraction (fire-and-forget, inspired by claude-code's
      // post-sampling SessionMemory hook and openclaw's daily-note convention)
      if (this.config.behavior.memoryExtraction && this.memory) {
        this.claude
          .extractMemory(msg.text, reply)
          .then((extracted) => {
            if (extracted && this.memory) {
              this.memory.append(extracted)
              return this.memory.save()
            }
          })
          .catch(() => undefined)
      }
    } catch (err) {
      logger.error(`Failed to handle message: ${err}`, this.botId)
      this.ipcSend({
        type: 'ERROR',
        botId: this.botId,
        code: 'HANDLE_ERROR',
        message: String(err),
      })
      this.ipcSend({
        type: 'WEB_REPLY_DONE',
        botId: this.botId,
        chatId: msg.chatId,
        messageId: streamMessageId,
        tokensUsed: 0,
        elapsedMs: Date.now() - startTime,
        fullText: '抱歉，处理您的消息时出现错误，请稍后再试。',
      })
      await this.sender
        .sendText(msg.chatId, msg.messageId, '抱歉，处理您的消息时出现错误，请稍后再试。')
        .catch(() => undefined)
    } finally {
      this.ipcSend({ type: 'HEARTBEAT_STOP', chatId: msg.chatId })
      this.ipcSend({ type: 'WEB_TYPING', botId: this.botId, chatId: msg.chatId, on: false })
      logger.diag(`HEARTBEAT_STOP sent for chat=${msg.chatId}`, this.botId)
    }
  }

  /**
   * Handle a task delegated from another agent.
   * Uses the full streaming + tools + workspace-context pipeline, then sends
   * the reply directly to the Feishu chat (no syntheticMsgId round-trip needed).
   */
  async handleDelegated(chatId: string, fromBotId: string, text: string, replyToMessageId?: string, delegationId?: string): Promise<void> {
    // Acknowledge receipt of delegation with a random emoji reaction on the original message
    if (replyToMessageId) {
      this.randomReaction(replyToMessageId)
    }

    const history = this.store.get(chatId)

    let extraCtx =
      `<current_session>\nchat_id: ${chatId}\nsender_user_id: ${fromBotId}\ncurrent_time: ${formatCurrentTime()}\n</current_session>`
    if (this.config.behavior.injectWorkspaceContext) {
      const workspaceCtx = await buildWorkspaceContext(this.botId).catch(() => undefined)
      if (workspaceCtx) extraCtx += '\n\n' + workspaceCtx
    }

    this.ipcSend({ type: 'HEARTBEAT_START', chatId, replyToMessageId: replyToMessageId ?? null })
    this.ipcSend({ type: 'WEB_TYPING', botId: this.botId, chatId, on: true })
    logger.diag(`HEARTBEAT_START sent for delegated chat=${chatId}`, this.botId)

    const startTime = Date.now()
    const streamMessageId = randomUUID()

    try {
      let reply = ''
      const { tokensUsed } = await this.claude.chatStream(
        history,
        text,
        (chunk) => {
          reply += chunk
          this.ipcSend({
            type: 'WEB_REPLY_CHUNK',
            botId: this.botId,
            chatId,
            messageId: streamMessageId,
            chunk,
          })
        },
        0,
        extraCtx,
        (toolName, inputSummary, claudeReasoning) => {
          logger.diag(`Tool starting: ${toolName}(${inputSummary.slice(0, 60)})`, this.botId)
          if (claudeReasoning) {
            this.ipcSend({ type: 'HEARTBEAT_UPDATE', chatId, reasoning: claudeReasoning })
          }
        },
        () => { this.ipcSend({ type: 'HEARTBEAT_UPDATE', chatId, reasoning: '正在生成回复...' }) },
      )

      this.store.append(chatId, text, reply)
      const elapsedMs = Date.now() - startTime
      this.ipcSend({
        type: 'WEB_REPLY_DONE',
        botId: this.botId,
        chatId,
        messageId: streamMessageId,
        tokensUsed,
        elapsedMs,
        fullText: reply,
      })
      if (!isWebChatId(chatId)) {
        await this.sender.sendText(chatId, null, reply)
      }

      logger.info(`Delegated reply sent (from=${fromBotId}), ${tokensUsed} tokens`, this.botId)
    } catch (err) {
      const elapsedMs = Date.now() - startTime
      logger.error(`Failed to handle delegated message: ${err}`, this.botId)
      this.ipcSend({
        type: 'WEB_REPLY_DONE',
        botId: this.botId,
        chatId,
        messageId: streamMessageId,
        tokensUsed: 0,
        elapsedMs,
        fullText: `抱歉，${this.botId} 处理委托任务时出现错误：${String(err).slice(0, 200)}`,
      })
    } finally {
      this.ipcSend({ type: 'HEARTBEAT_STOP', chatId })
      this.ipcSend({ type: 'WEB_TYPING', botId: this.botId, chatId, on: false })
      logger.diag(`HEARTBEAT_STOP sent for delegated chat=${chatId}`, this.botId)
      // Notify the delegating bot to stop its progress-inquiry timer
      if (delegationId) {
        this.ipcSend({ type: 'DELEGATE_DONE', fromBotId: this.botId, delegatorBotId: fromBotId, delegationId })
        logger.diag(`DELEGATE_DONE sent: id=${delegationId} delegator=${fromBotId}`, this.botId)
      }
    }
  }

  async handleInjected(chatId: string, _userId: string, text: string, syntheticMsgId: string): Promise<void> {
    const history = this.store.get(chatId)
    const { text: reply, tokensUsed } = await this.claude.chat(history, text)
    this.store.append(chatId, text, reply)

    this.ipcSend({
      type: 'INJECT_REPLY',
      botId: this.botId,
      syntheticMsgId,
      replyText: reply,
    })

    logger.info(`Inject reply sent, ${tokensUsed} tokens`, this.botId)
  }

  /**
   * Handle a message originating from the Web IM frontend.
   * Skips Feishu policy gates (web is its own surface, not bound by group/DM rules)
   * but reuses the same ConversationStore + claude.chatStream + memory pipeline,
   * so Web and Feishu on the same chatId share history seamlessly.
   *
   * Streams chunks back to web subscribers via WEB_REPLY_CHUNK and signals
   * completion with WEB_REPLY_DONE.
   */
  async handleWebMessage(
    chatId: string,
    userId: string,
    text: string,
    streamMessageId: string,
    routeMode: 'default' | 'direct_self' = 'default',
    webHistory: ConversationTurn[] = [],
  ): Promise<void> {
    logger.info(`Web message received: chatId=${chatId} from=${userId} text="${text.slice(0, 100)}"`, this.botId)

    const startTime = Date.now()
    this.ipcSend({ type: 'WEB_TYPING', botId: this.botId, chatId, on: true })
    this.ipcSend({ type: 'HEARTBEAT_START', chatId, replyToMessageId: null, messageId: streamMessageId })

    try {
      const memoryHistory = this.store.get(chatId)
      const history = routeMode === 'direct_self'
        ? []
        : memoryHistory.length > 0
          ? memoryHistory
          : webHistory
      const effectiveText = routeMode === 'direct_self'
        ? [
            '【群聊直达发言】',
            `你的 Agent ID 是：${this.botId}`,
            '请直接回答用户原始请求中属于你自己的部分。',
            '如果用户要求自我介绍，请用第一人称介绍你的职责、你能产出什么、用户何时应该找你。',
            '禁止回答“已完成”“已在群里完成”“我已经介绍过”等完成状态句。',
            '禁止代表其他 Agent 发言，禁止委托给其他 Agent。',
            '',
            `用户原始请求：${text}`,
          ].join('\n')
        : text

      let extraSystemContext =
        `<current_session>\nchat_id: ${chatId}\nsender_user_id: ${userId}\ncurrent_time: ${formatCurrentTime()}\nsource: web\n</current_session>`
      if (routeMode === 'direct_self') {
        extraSystemContext +=
          '\n\n<web_group_direct_reply>\n' +
          '这是一条 Web 群聊直达消息，你是被要求直接发言的成员之一。\n' +
          '只代表你自己回答，只介绍/交付你自己的部分。\n' +
          '不要替其他 Agent 总结，不要说“已完成”，不要再委托给其他 Agent。\n' +
          '如果用户要求“各个/每个/所有 Agent”回答，你只回答属于你自己的那一份。\n' +
          '</web_group_direct_reply>'
      }
      if (this.config.behavior.injectWorkspaceContext) {
        const workspaceCtx = await buildWorkspaceContext(this.botId).catch(() => undefined)
        if (workspaceCtx) extraSystemContext += '\n\n' + workspaceCtx
      }

      let reply = ''
      const { tokensUsed } = await this.claude.chatStream(
        history,
        effectiveText,
        (chunk) => {
          reply += chunk
          this.ipcSend({
            type: 'WEB_REPLY_CHUNK',
            botId: this.botId,
            chatId,
            messageId: streamMessageId,
            chunk,
          })
        },
        0,
        extraSystemContext,
        (toolName, inputSummary, claudeReasoning) => {
          logger.diag(`Tool starting: ${toolName}(${inputSummary.slice(0, 60)})`, this.botId)
          if (claudeReasoning) {
            this.ipcSend({ type: 'HEARTBEAT_UPDATE', chatId, reasoning: claudeReasoning })
          }
        },
        () => { this.ipcSend({ type: 'HEARTBEAT_UPDATE', chatId, reasoning: '正在生成回复...' }) },
      )

      this.store.append(chatId, effectiveText, reply)
      if (routeMode !== 'direct_self') {
        this.store
          .compactIfNeeded(chatId, (turns) => this.claude.summarize(turns))
          .catch(() => undefined)
      }

      const elapsedMs = Date.now() - startTime
      this.ipcSend({
        type: 'WEB_REPLY_DONE',
        botId: this.botId,
        chatId,
        messageId: streamMessageId,
        tokensUsed,
        elapsedMs,
        fullText: reply,
      })

      logger.info(`Web reply complete in ${elapsedMs}ms, ${tokensUsed} tokens`, this.botId)

      if (this.config.behavior.memoryExtraction && this.memory) {
        this.claude
          .extractMemory(text, reply)
          .then((extracted) => {
            if (extracted && this.memory) {
              this.memory.append(extracted)
              return this.memory.save()
            }
          })
          .catch(() => undefined)
      }
    } catch (err) {
      logger.error(`Failed to handle web message: ${err}`, this.botId)
      this.ipcSend({
        type: 'WEB_REPLY_DONE',
        botId: this.botId,
        chatId,
        messageId: streamMessageId,
        tokensUsed: 0,
        elapsedMs: Date.now() - startTime,
        fullText: `抱歉，处理消息时出现错误：${String(err).slice(0, 200)}`,
      })
    } finally {
      this.ipcSend({ type: 'HEARTBEAT_STOP', chatId })
      this.ipcSend({ type: 'WEB_TYPING', botId: this.botId, chatId, on: false })
    }
  }

  // ─── Gate ────────────────────────────────────────────────────────────────

  private checkGate(msg: FeishuMessage): { allowed: boolean; reason?: string } {
    const { access } = this.config
    const isDM = msg.chatType === 'p2p'
    const isGroup = msg.chatType === 'group'

    // ── DM policy ──────────────────────────────────────────────────────────
    if (isDM) {
      if (access.dmPolicy === 'disabled') {
        return { allowed: false, reason: `DM disabled for bot ${this.botId}` }
      }
      if (access.dmPolicy === 'allowlist' && !access.allowFrom.includes(msg.senderId)) {
        return { allowed: false, reason: `DM sender ${msg.senderId} not in allowlist` }
      }
    }

    // ── Group policy ───────────────────────────────────────────────────────
    if (isGroup) {
      if (access.groupPolicy === 'disabled') {
        return { allowed: false, reason: `Group messages disabled for bot ${this.botId}` }
      }

      if (access.groupPolicy === 'allowlist') {
        const allowed =
          access.allowFrom.includes(msg.chatId) || access.allowFrom.includes(msg.senderId)
        if (!allowed) {
          return { allowed: false, reason: `Group/sender not in allowlist` }
        }
      }

      // @mention gate: only respond when bot is explicitly @mentioned
      if (access.requireMention) {
        if (!this.botOpenId) {
          // Can't verify @mention without knowing our own open_id — block to avoid broadcast
          return {
            allowed: false,
            reason: `requireMention is enabled but bot open_id is unknown — blocking until open_id resolves`,
          }
        } else {
          const botDirectlyMentioned = msg.mentions.some(
            (m: MentionInfo) => m.openId === this.botOpenId && !m.isAll,
          )
          const allMentioned = msg.mentions.some((m: MentionInfo) => m.isAll)
          const passViaAll = allMentioned && access.respondToMentionAll

          if (!botDirectlyMentioned && !passViaAll) {
            return {
              allowed: false,
              reason: `Bot not @mentioned in group ${msg.chatId} (requireMention=true)`,
            }
          }
        }
      }
    }

    // ── Deny list (applies to all chat types) ──────────────────────────────
    if (access.denyFrom.includes(msg.senderId)) {
      return { allowed: false, reason: `Sender ${msg.senderId} in denyFrom list` }
    }

    return { allowed: true }
  }
}

function isWebChatId(chatId: string): boolean {
  return chatId.startsWith('web-')
}
