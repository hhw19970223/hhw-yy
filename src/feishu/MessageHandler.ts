import type { FeishuMessage, MentionInfo } from './FeishuClient.js'
import { ClaudeClient } from '../llm/ClaudeClient.js'
import { ConversationStore } from '../session/ConversationStore.js'
import { MemoryStore } from '../memory/MemoryStore.js'
import type { FeishuSender } from './reply/Sender.js'
import { logger } from '../shared/logger.js'
import type { LoadedSubAgentConfig } from '../config/schema.js'
import type { UpwardMessage } from '../process/ipc/types.js'
import { buildWorkspaceContext } from '../workspace/WorkspaceManager.js'

export type IpcSend = (msg: UpwardMessage) => void

const SUPPORTED_MESSAGE_TYPES = new Set(['text', 'post'])

export class MessageHandler {
  private botOpenId: string | null = null

  constructor(
    private readonly botId: string,
    private readonly config: LoadedSubAgentConfig,
    private readonly claude: ClaudeClient,
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
    const reactions = ['PROUD', 'WITTY', 'SMART', 'SCOWL', 'ERROR']
    const reaction = reactions[Math.floor(Math.random() * reactions.length)]!
    this.sender.addReaction(msg.messageId, reaction).catch(() => undefined)
  }

  async handle(msg: FeishuMessage): Promise<void> {
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

    // Log incoming message
    const mentionStr = msg.mentions.length
      ? ` mentions=[${msg.mentions.map((m) => m.name).join(', ')}]`
      : ''
    logger.info(
      `Incoming ${msg.chatType} message | from=${msg.senderId}${mentionStr} | text="${msg.text}"`,
      this.botId,
    )

    const startTime = Date.now()

    this.ipcSend({
      type: 'MESSAGE_RECEIVED',
      botId: this.botId,
      chatId: msg.chatId,
      userId: msg.senderId,
      messageId: msg.messageId,
      textPreview: msg.text.slice(0, 100),
    })

    // Infrastructure-level heartbeat: fires every 2 min regardless of what
    // Claude or tools are doing. Uses emoji reactions so it doesn't clutter chat.
    const HEARTBEAT_REACTIONS = ['THINKING', 'WRITING', 'SEARCH', 'CLAPPING', 'THUMBSUP']
    let heartbeatTick = 0
    const heartbeat = setInterval(() => {
      const reaction = HEARTBEAT_REACTIONS[heartbeatTick % HEARTBEAT_REACTIONS.length]!
      heartbeatTick++
      this.sender.addReaction(msg.messageId, reaction).catch(() => undefined)
    }, 2 * 60_000)

    try {
      // Stage 5: Build Claude input
      // msg.text is already clean (mention keys stripped by FeishuClient)
      const history = this.store.get(msg.chatId)

      // Stage 5a: Build system context — session info + workspace files
      // chat_id is always injected so agents can use it in delegate_to_agent calls
      // current_time is injected so agents can track elapsed time for progress reporting
      const now = new Date()
      const currentTime = `${now.toLocaleDateString('zh-CN')} ${now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
      let extraSystemContext =
        `<current_session>\nchat_id: ${msg.chatId}\nsender_user_id: ${msg.senderId}\ncurrent_time: ${currentTime}\n</current_session>`
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
        (chunk) => { reply += chunk },
        0,
        extraSystemContext,
        (toolName, inputSummary) => {
          this.sender
            .sendText(msg.chatId, msg.messageId, `⚙️ 正在执行: **${toolName}**\n\`${inputSummary}\``)
            .catch(() => undefined)
        },
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
      await this.sender
        .sendText(msg.chatId, msg.messageId, '抱歉，处理您的消息时出现错误，请稍后再试。')
        .catch(() => undefined)
    } finally {
      clearInterval(heartbeat)
    }
  }

  /**
   * Handle a task delegated from another agent.
   * Uses the full streaming + tools + workspace-context pipeline, then sends
   * the reply directly to the Feishu chat (no syntheticMsgId round-trip needed).
   */
  async handleDelegated(chatId: string, fromBotId: string, text: string, replyToMessageId?: string): Promise<void> {
    // Acknowledge receipt of delegation with an emoji reaction on the original message
    if (replyToMessageId) {
      this.sender.addReaction(replyToMessageId, 'THUMBSUP').catch(() => undefined)
    }

    const history = this.store.get(chatId)

    const nowD = new Date()
    const currentTimeD = `${nowD.toLocaleDateString('zh-CN')} ${nowD.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
    let extraCtx =
      `<current_session>\nchat_id: ${chatId}\nsender_user_id: ${fromBotId}\ncurrent_time: ${currentTimeD}\n</current_session>`
    if (this.config.behavior.injectWorkspaceContext) {
      const workspaceCtx = await buildWorkspaceContext(this.botId).catch(() => undefined)
      if (workspaceCtx) extraCtx += '\n\n' + workspaceCtx
    }

    let reply = ''
    const { tokensUsed } = await this.claude.chatStream(
      history,
      text,
      (chunk) => { reply += chunk },
      0,
      extraCtx,
      (toolName, inputSummary) => {
        this.sender
          .sendText(chatId, null, `⚙️ 正在执行: **${toolName}**\n\`${inputSummary}\``)
          .catch(() => undefined)
      },
    )

    this.store.append(chatId, text, reply)
    await this.sender.sendText(chatId, null, reply)

    logger.info(`Delegated reply sent (from=${fromBotId}), ${tokensUsed} tokens`, this.botId)
  }

  async handleInjected(chatId: string, userId: string, text: string, syntheticMsgId: string): Promise<void> {
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
    void userId
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
