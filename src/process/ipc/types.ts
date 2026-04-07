import type { BotStatus } from '../../shared/types.js'
import type { FeishuMessage } from '../../feishu/FeishuClient.js'

// ─── Manager → Child (Downward) ───────────────────────────────────────────

export type DownwardMessage =
  | { type: 'PING'; id: string }
  | { type: 'STOP'; gracePeriodMs: number }
  | { type: 'RELOAD_CONFIG' }
  | { type: 'INJECT_MESSAGE'; chatId: string; userId: string; text: string; syntheticMsgId: string }
  /** Gateway → Worker: a parsed Feishu message ready for handling */
  | { type: 'FEISHU_MESSAGE'; message: FeishuMessage }
  /** Gateway → Worker: bot's own open_id, used for self-message + @mention checks */
  | { type: 'SET_BOT_INFO'; botOpenId: string }
  /** Manager → Worker: a task delegated by another agent */
  | { type: 'DELEGATE_MESSAGE'; chatId: string; fromBotId: string; text: string; replyToMessageId?: string }

// ─── Child → Manager (Upward) ─────────────────────────────────────────────

export type UpwardMessage =
  | { type: 'READY'; botId: string; pid: number; connectedAt: string }
  | { type: 'PONG'; botId: string; replyTo: string; timestamp: string }
  | {
      type: 'STATUS_UPDATE'
      botId: string
      status: BotStatus
      activeChatCount: number
      lastMessageAt: string | null
      restartCount: number
    }
  | { type: 'MESSAGE_RECEIVED'; botId: string; chatId: string; userId: string; messageId: string; textPreview: string }
  | {
      type: 'REPLY_SENT'
      botId: string
      chatId: string
      messageId: string
      replyId: string
      tokensUsed: number
      elapsedMs: number
    }
  | { type: 'INJECT_REPLY'; botId: string; syntheticMsgId: string; replyText: string }
  | { type: 'ERROR'; botId: string; code: string; message: string; context?: unknown }
  | { type: 'FATAL'; botId: string; code: string; message: string; stack?: string }
  | { type: 'LOG'; botId: string; level: 'debug' | 'info' | 'warn' | 'error'; message: string; timestamp: string }
  /** Worker → Gateway: send a text reply via the Feishu bot */
  | { type: 'FEISHU_SEND'; chatId: string; replyToMessageId: string | null; text: string }
  /** Worker → Gateway: add a reaction emoji to a message */
  | { type: 'FEISHU_REACTION_ADD'; messageId: string; reactionType: string }
  /** Worker → Gateway: remove a reaction emoji from a message */
  | { type: 'FEISHU_REACTION_REMOVE'; messageId: string; reactionId: string }
  /** Worker → Manager: delegate a task to another agent's worker */
  | { type: 'DELEGATE_TO'; targetBotId: string; chatId: string; fromBotId: string; text: string; replyToMessageId?: string }

export function isUpwardMessage(msg: unknown): msg is UpwardMessage {
  return typeof msg === 'object' && msg !== null && 'type' in msg
}
