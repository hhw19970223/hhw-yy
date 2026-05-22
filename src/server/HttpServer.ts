import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import { WebSocketServer, type WebSocket } from 'ws'
import { randomUUID } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join, basename } from 'path'
import type { Manager, WebEvent, WebEventListener } from '../process/Manager.js'
import { Paths } from '../config/paths.js'
import type { LoadedMainAgentConfig, WebConversation } from '../config/schema.js'
import { logger } from '../shared/logger.js'
import { registerCronTask, startCronScheduler } from './CronScheduler.js'
import { listSkills } from './SkillCatalog.js'
import { analyzeSkillParams } from './SkillAnalyzer.js'
import { WebStore } from './WebStore.js'
import { ClaudeClient } from '../llm/ClaudeClient.js'
import { contentTypeFor, extractAttachmentPreview, materializeLocalFileAttachments } from './AttachmentMaterializer.js'
import type { ConversationTurn } from '../session/ConversationStore.js'

const MAX_WEB_UPLOAD_BYTES = 10 * 1024 * 1024

/**
 * Public roster entry shown to the Web IM frontend. Mirrors what `/bots`
 * returns but enriches with role / description so the UI can render avatars.
 */
interface WebAgentEntry {
  id: string
  name: string
  role: 'manager' | 'kol' | 'seo' | 'social' | 'other'
  description: string
  status: string
  pid: number | null
  restartCount: number
  isMainAgent: boolean
  mainAgentId: string
}

interface WebConversationEntry extends WebConversation {
  title: string
  kind: 'private' | 'group'
  members: string[]
}

/**
 * Bot id → role mapping. The frontend already has agent role colors
 * keyed by these labels, so we infer from id substrings.
 */
function inferRole(id: string): WebAgentEntry['role'] {
  if (id.includes('运营经理') || id.toLowerCase().includes('manager')) return 'manager'
  if (id.includes('KOL') || id.toLowerCase().includes('kol')) return 'kol'
  if (id.includes('SEO') || id.toLowerCase().includes('seo')) return 'seo'
  if (id.includes('社媒') || id.toLowerCase().includes('social')) return 'social'
  return 'other'
}

function inferDescription(role: WebAgentEntry['role']): string {
  switch (role) {
    case 'manager': return '统筹三条业务线,接收人工任务并派发'
    case 'kol': return '找 KOL → 验邮箱 → 起草 DM → 跟进'
    case 'seo': return '选题 → 写稿 → 质量门 → 发布'
    case 'social': return '把内容改写为多平台版本并定时发布'
    default: return ''
  }
}

function groupPrimaryBotId(botIds: string[]): string {
  return botIds.find((id) => inferRole(id) === 'manager' || id.includes('产品经理')) ?? botIds[0]
}

function orderGroupBotIds(botIds: string[]): string[] {
  const primary = groupPrimaryBotId(botIds)
  return [primary, ...botIds.filter((id) => id !== primary)]
}

/**
 * Build configured Web IM conversations. When none are configured, start with
 * an empty session list; users create private/group sessions from the UI.
 */
function defaultConversations(agents: LoadedMainAgentConfig[]): WebConversationEntry[] {
  void agents
  return []
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders() })
  res.end(JSON.stringify(body))
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'Content-Type': contentType, ...corsHeaders() })
  res.end(body)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function safeFileName(name: string): string {
  return basename(name).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 120) || 'file'
}

function webMessagesToHistory(messages: ReturnType<WebStore['listMessages']>): ConversationTurn[] {
  return messages
    .filter((message) => message.kind === 'text' && (message.role === 'user' || message.role === 'agent'))
    .slice(-20)
    .map((message) => ({
      role: message.role === 'user' ? 'user' : 'assistant',
      content: message.content,
      timestamp: message.createdAt,
    }))
}

function extractMentionTargets(
  text: string,
  conversation: ReturnType<WebStore['getConversation']>,
  botName: Map<string, string>,
  authorBotId: string,
): string[] {
  if (!conversation || conversation.kind !== 'group') return []
  return conversation.members
    .filter((botId) => botId !== 'me' && botId !== authorBotId)
    .filter((botId) => {
      const name = botName.get(botId) ?? botId
      return text.includes(`@${name}`) || text.includes(`@${botId}`)
    })
    .filter((botId, index, arr) => arr.indexOf(botId) === index)
}

function buildMentionRelayText(fromName: string, text: string): string {
  return [
    `【群聊点名】${fromName} 在群聊中 @ 了你。`,
    '请只回应其中点名给你的部分，直接在当前群聊给出你的自我介绍或交付内容。',
    '',
    text,
  ].join('\n')
}

function safePathSegment(value: string): string {
  return value.replace(/[^\w.\-]/g, '_').slice(0, 160) || 'default'
}

async function writeWorkspaceUpload(
  store: WebStore,
  chatId: string,
  storedName: string,
  buffer: Buffer,
): Promise<string | undefined> {
  const conversation = store.getConversation(chatId)
  if (!conversation) return undefined
  const baseDir = conversation.kind === 'group'
    ? Paths.workspaceCommon
    : Paths.workspaceBot(conversation.botId)
  const uploadDir = join(baseDir, 'uploads', safePathSegment(chatId))
  await mkdir(uploadDir, { recursive: true })
  const filePath = join(uploadDir, storedName)
  await writeFile(filePath, buffer)
  return filePath
}

async function translateMarkdownToChinese(agents: LoadedMainAgentConfig[], text: string): Promise<string> {
  const config = agents[0]?.claude
  const apiKey = config?.apiKey ?? process.env.ANTHROPIC_API_KEY
  if (!config || !apiKey) throw new Error('No Claude config available for translation')

  const client = new ClaudeClient({
    apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    maxTokens: Math.min(config.maxTokens ?? 8192, 4096),
    systemPrompt: [
      '你是一个 Markdown 翻译器，只把用户提供的 Markdown 翻译成简体中文。',
      '保留原始 Markdown 结构、标题层级、列表、表格、链接 URL、图片语法、引用和代码块。',
      '代码块与行内代码内容保持原样；只翻译自然语言文本。',
      '不要添加解释、前后缀、寒暄或代码围栏外的额外内容。',
    ].join('\n'),
  })

  const result = await client.chat([], text.slice(0, 30_000))
  return result.text.trim()
}

interface HttpServerDeps {
  manager: Manager
  agents: LoadedMainAgentConfig[]
  webConversations: WebConversation[]
}

/**
 * HTTP + WebSocket server.
 *
 * REST:
 *   GET  /health                           — uptime probe
 *   GET  /bots                             — legacy: BotSnapshot[]
 *   GET  /bots/:botId                      — legacy: BotSnapshot | 404
 *   GET  /web/agents                       — Web IM agent roster
 *   GET  /web/conversations                — Web IM conversation list from SQLite
 *   POST /web/conversations                — create a Web IM private/group task
 *   PATCH /web/conversations/:chatId       — rename a Web IM task
 *   GET  /web/messages?chatId=             — persisted messages from SQLite
 *   GET  /web/tasks                        — current tasks from SQLite
 *   GET  /web/tool-logs                    — tool invocation log rows from SQLite
 *   GET  /web/skills                       — interactive skill catalog from public skill files
 *   POST /web/translate { text }           — translate one Markdown bubble to Simplified Chinese
 *   POST /web/messages  { botId, chatId, text }  — send a user message; returns { messageId, userMessageId }
 *
 * WebSocket:
 *   /web/stream — receives JSON frames pushed by Manager:
 *     { type:'chunk',  botId, chatId, messageId, chunk }
 *     { type:'done',   botId, chatId, messageId, tokensUsed, elapsedMs, fullText }
 *     { type:'typing', botId, chatId, on }
 *     { type:'agent_status', botId, status }
 */
export function startHttpServer(deps: HttpServerDeps, port: number): Server {
  const { manager, agents, webConversations } = deps

  const conversations: WebConversationEntry[] =
    webConversations.length > 0
      ? webConversations.map((c) => ({
          botId: c.botId,
          chatId: c.chatId,
          title: c.title ?? c.chatId,
          kind: c.kind,
          members: ['me', c.botId],
        }))
      : defaultConversations(agents)
  const store = new WebStore(Paths.webImDb)
  store.seedConversations(conversations)
  const stopCronScheduler = startCronScheduler(store, manager)

  // Flat lookup: botId → display name (used when reading history)
  const botName = new Map<string, string>()
  for (const main of agents) {
    botName.set(main.id, main.name ?? main.id)
    for (const sub of main.subAgents) botName.set(sub.id, sub.name ?? sub.id)
  }
  const knownBotIds = new Set(botName.keys())

  manager.subscribeWeb((event) => {
    if (event.type !== 'done') return
    const fullText = materializeLocalFileAttachments(event.fullText)
    event.fullText = fullText
    store.addAgentMessage({
      id: event.messageId,
      chatId: event.chatId,
      botId: event.botId,
      authorName: botName.get(event.botId) ?? event.botId,
      text: fullText,
    })
    const conversation = store.getConversation(event.chatId)
    const mentionTargets = extractMentionTargets(fullText, conversation, botName, event.botId)
    if (mentionTargets.length === 0) return
    const relayText = buildMentionRelayText(botName.get(event.botId) ?? event.botId, fullText)
    mentionTargets.forEach((botId, index) => {
      try {
        manager.sendWebMessage(
          botId,
          event.chatId,
          event.botId,
          relayText,
          'direct_self',
          index * 3500,
          [],
        )
      } catch (err) {
        logger.warn(`Failed to relay web mention ${event.botId} -> ${botId}: ${err}`)
      }
    })
  })

  // Build agent roster from config
  function buildAgentRoster(): WebAgentEntry[] {
    const roster: WebAgentEntry[] = []
    for (const main of agents) {
      const snapshot = manager.getSnapshot(main.id)
      const role = inferRole(main.id)
      roster.push({
        id: main.id,
        name: main.name ?? main.id,
        role,
        description: inferDescription(role),
        status: snapshot?.status ?? 'STOPPED',
        pid: snapshot?.pid ?? null,
        restartCount: snapshot?.restartCount ?? 0,
        isMainAgent: true,
        mainAgentId: main.id,
      })
      for (const sub of main.subAgents) {
        const subSnap = manager.getSnapshot(sub.id)
        const subRole = inferRole(sub.id)
        roster.push({
          id: sub.id,
          name: sub.name ?? sub.id,
          role: subRole,
          description: inferDescription(subRole),
          status: subSnap?.status ?? 'STOPPED',
          pid: subSnap?.pid ?? null,
          restartCount: subSnap?.restartCount ?? 0,
          isMainAgent: false,
          mainAgentId: main.id,
        })
      }
    }
    return roster
  }

  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders())
      res.end()
      return
    }

    const url = req.url ?? '/'

    // ── Legacy routes (kept for backwards compat) ───────────────────────────
    if (req.method === 'GET' && url === '/health') {
      sendJson(res, 200, { status: 'ok', uptime: Math.floor(process.uptime()) })
      return
    }
    if (req.method === 'GET' && url === '/bots') {
      sendJson(res, 200, manager.listSnapshots())
      return
    }
    const legacyMatch = url.match(/^\/bots\/([^/?]+)$/)
    if (req.method === 'GET' && legacyMatch) {
      const botId = decodeURIComponent(legacyMatch[1])
      const snapshot = manager.getSnapshot(botId)
      if (!snapshot) { sendJson(res, 404, { error: `Bot "${botId}" not found` }); return }
      sendJson(res, 200, snapshot)
      return
    }

    // ── Web IM routes ───────────────────────────────────────────────────────
    if (req.method === 'GET' && url === '/web/agents') {
      sendJson(res, 200, buildAgentRoster())
      return
    }

    if (req.method === 'GET' && url === '/web/conversations') {
      sendJson(res, 200, store.listConversations())
      return
    }

    const uploadPreviewMatch = url.match(/^\/web\/uploads\/([^/?]+)\/preview(?:\?.*)?$/)
    if (req.method === 'GET' && uploadPreviewMatch) {
      try {
        const fileName = safeFileName(decodeURIComponent(uploadPreviewMatch[1]))
        const filePath = join(Paths.webUploadsDir, fileName)
        const preview = await extractAttachmentPreview(filePath, fileName)
        sendJson(res, 200, preview)
      } catch (err) {
        sendJson(res, 422, { error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    if (req.method === 'GET' && url.startsWith('/web/uploads/')) {
      try {
        const fileName = safeFileName(decodeURIComponent(url.replace('/web/uploads/', '').split('?')[0] ?? ''))
        const filePath = join(Paths.webUploadsDir, fileName)
        const body = await readFile(filePath)
        sendBytes(res, 200, body, contentTypeFor(fileName))
      } catch {
        sendJson(res, 404, { error: 'File not found' })
      }
      return
    }

    if (req.method === 'POST' && url === '/web/uploads') {
      try {
        const body = await readBody(req)
        const parsed = JSON.parse(body) as { name?: string; type?: string; data?: string; chatId?: string }
        if (!parsed.name || !parsed.data) {
          sendJson(res, 400, { error: 'name and data are required' })
          return
        }
        const buffer = Buffer.from(parsed.data, 'base64')
        if (buffer.byteLength > MAX_WEB_UPLOAD_BYTES) {
          sendJson(res, 413, { error: 'File is larger than 10MB' })
          return
        }
        await mkdir(Paths.webUploadsDir, { recursive: true })
        const storedName = `${randomUUID()}-${safeFileName(parsed.name)}`
        await writeFile(join(Paths.webUploadsDir, storedName), buffer)
        const workspacePath = parsed.chatId
          ? await writeWorkspaceUpload(store, parsed.chatId, storedName, buffer)
          : undefined
        sendJson(res, 201, {
          id: storedName,
          name: parsed.name,
          type: parsed.type || contentTypeFor(parsed.name),
          size: buffer.byteLength,
          url: `/web/uploads/${encodeURIComponent(storedName)}`,
          workspacePath,
        })
      } catch (err) {
        sendJson(res, 500, { error: String(err) })
      }
      return
    }

    if (req.method === 'POST' && url === '/web/conversations') {
      try {
        const body = await readBody(req)
        const parsed = JSON.parse(body) as {
          title?: string
          kind?: 'private' | 'group'
          botId?: string
          botIds?: string[]
          icon?: string
        }
        const kind = parsed.kind ?? 'group'
        const botIds = kind === 'private'
          ? [parsed.botId ?? parsed.botIds?.[0] ?? '']
          : [...new Set(parsed.botIds ?? [])]
        const validBotIds = botIds.filter((botId) => knownBotIds.has(botId))
        if (validBotIds.length === 0) {
          sendJson(res, 400, { error: 'At least one valid botId is required' })
          return
        }
        const orderedBotIds = kind === 'group' ? orderGroupBotIds(validBotIds) : validBotIds
        const primaryBotId = orderedBotIds[0]
        const title = (parsed.title?.trim() || (kind === 'group'
          ? `群聊 ${new Date().toLocaleString('zh-CN')}`
          : botName.get(primaryBotId) ?? primaryBotId)).slice(0, 80)
        const chatId = kind === 'private'
          ? `web-private-${primaryBotId}-${randomUUID()}`
          : `web-group-${randomUUID()}`
        const conversation = store.createConversation({
          chatId,
          botId: primaryBotId,
          title,
          kind,
          members: ['me', ...orderedBotIds],
          icon: kind === 'group' ? parsed.icon ?? 'users' : null,
        })
        sendJson(res, 201, conversation)
      } catch (err) {
        sendJson(res, 500, { error: String(err) })
      }
      return
    }

    const webConversationMatch = url.match(/^\/web\/conversations\/([^/?]+)$/)
    if (req.method === 'PATCH' && webConversationMatch) {
      try {
        const chatId = decodeURIComponent(webConversationMatch[1])
        const body = await readBody(req)
        const parsed = JSON.parse(body) as { title?: string; archived?: boolean; icon?: string }
        const conversation = parsed.archived
          ? store.archiveConversation(chatId)
          : typeof parsed.icon === 'string'
            ? store.updateConversationIcon(chatId, parsed.icon)
          : store.renameConversation(chatId, parsed.title ?? '')
        if (!conversation) {
          sendJson(res, 404, { error: 'Task not found or invalid update' })
          return
        }
        sendJson(res, 200, conversation)
      } catch (err) {
        sendJson(res, 500, { error: String(err) })
      }
      return
    }

    if (req.method === 'DELETE' && webConversationMatch) {
      const chatId = decodeURIComponent(webConversationMatch[1])
      const deleted = store.deleteConversation(chatId)
      if (!deleted) {
        sendJson(res, 404, { error: 'Task not found' })
        return
      }
      sendJson(res, 200, { ok: true })
      return
    }

    if (req.method === 'GET' && url.startsWith('/web/messages')) {
      const u = new URL(url, 'http://x')
      const chatId = u.searchParams.get('chatId') ?? ''
      if (!chatId) { sendJson(res, 400, { error: 'chatId is required' }); return }
      sendJson(res, 200, store.listMessages(chatId))
      return
    }

    if (req.method === 'GET' && url === '/web/tasks') {
      sendJson(res, 200, store.listTasks())
      return
    }

    if (req.method === 'GET' && url === '/web/tool-logs') {
      sendJson(res, 200, store.listToolLogs())
      return
    }

    if (req.method === 'GET' && url === '/web/scheduled-tasks') {
      sendJson(res, 200, store.listScheduledTasks())
      return
    }

    const scheduledTaskMatch = url.match(/^\/web\/scheduled-tasks\/([^/?]+)$/)
    if (req.method === 'DELETE' && scheduledTaskMatch) {
      const id = decodeURIComponent(scheduledTaskMatch[1])
      const deleted = store.deleteScheduledTask(id)
      if (!deleted) {
        sendJson(res, 404, { error: 'Scheduled task not found' })
        return
      }
      sendJson(res, 200, { ok: true })
      return
    }

    if (req.method === 'GET' && url === '/web/skills') {
      sendJson(res, 200, await listSkills())
      return
    }

    if (req.method === 'POST' && url === '/web/skills/analyze') {
      try {
        const body = await readBody(req)
        const parsed = JSON.parse(body) as { botId?: string; skillId?: string }
        if (!parsed.botId || !parsed.skillId) {
          sendJson(res, 400, { error: 'botId and skillId are required' })
          return
        }
        const result = await analyzeSkillParams({
          manager,
          botId: parsed.botId,
          skillId: parsed.skillId,
        })
        sendJson(res, 200, result)
      } catch (err) {
        sendJson(res, 500, { error: String(err) })
      }
      return
    }

    if (req.method === 'POST' && url === '/web/translate') {
      try {
        const body = await readBody(req)
        const parsed = JSON.parse(body) as { text?: string }
        const text = parsed.text?.trim()
        if (!text) {
          sendJson(res, 400, { error: 'text is required' })
          return
        }
        const translated = await translateMarkdownToChinese(agents, text)
        sendJson(res, 200, { text: translated })
      } catch (err) {
        sendJson(res, 500, { error: String(err) })
      }
      return
    }

    if (req.method === 'POST' && url === '/internal/delegate') {
      try {
        const body = await readBody(req)
        const parsed = JSON.parse(body) as {
          fromBotId?: string
          targetBotId?: string
          chatId?: string
          message?: string
        }
        if (!parsed.fromBotId || !parsed.targetBotId || !parsed.chatId || !parsed.message) {
          sendJson(res, 400, { error: 'fromBotId, targetBotId, chatId and message are required' })
          return
        }
        if (!knownBotIds.has(parsed.fromBotId) || !knownBotIds.has(parsed.targetBotId)) {
          sendJson(res, 404, { error: 'Unknown fromBotId or targetBotId' })
          return
        }
        if (parsed.fromBotId === parsed.targetBotId) {
          sendJson(res, 400, { error: 'Cannot delegate to self' })
          return
        }
        const result = manager.delegateToAgent({
          fromBotId: parsed.fromBotId,
          targetBotId: parsed.targetBotId,
          chatId: parsed.chatId,
          text: `[来自 ${parsed.fromBotId} 的委托]\n\n${parsed.message}`,
        })
        sendJson(res, result.ok ? 200 : 409, result)
      } catch (err) {
        sendJson(res, 500, { error: String(err) })
      }
      return
    }

    if (req.method === 'POST' && url === '/internal/scheduled-tasks') {
      try {
        const body = await readBody(req)
        const parsed = JSON.parse(body) as {
          chatId?: string
          botIds?: string[]
          cron?: string
          prompt?: string
          title?: string
        }
        const botIds = [...new Set((parsed.botIds ?? []).filter((id): id is string => typeof id === 'string' && knownBotIds.has(id)))]
        if (!parsed.chatId || botIds.length === 0 || !parsed.cron || !parsed.prompt) {
          sendJson(res, 400, { error: 'chatId, botIds, cron and prompt are required' })
          return
        }
        const scheduledTask = registerCronTask(store, {
          chatId: parsed.chatId,
          botIds,
          text: `cron ${parsed.cron} ${parsed.prompt}`,
          title: parsed.title,
        })
        if (!scheduledTask) {
          sendJson(res, 400, { error: 'invalid cron expression' })
          return
        }
        sendJson(res, 200, scheduledTask)
      } catch (err) {
        sendJson(res, 500, { error: String(err) })
      }
      return
    }

    if (req.method === 'POST' && url === '/web/ui-messages') {
      try {
        const body = await readBody(req)
        const parsed = JSON.parse(body) as {
          id?: string
          chatId?: string
          role?: 'user' | 'agent' | 'system'
          authorId?: string
          authorName?: string
          createdAt?: string
          kind?: string
          content?: unknown
          preview?: string
        }
        if (!parsed.id || !parsed.chatId || !parsed.kind || parsed.content === undefined) {
          sendJson(res, 400, { error: 'id, chatId, kind, content are required' })
          return
        }
        const content = typeof parsed.content === 'string'
          ? parsed.content
          : JSON.stringify(parsed.content)
        store.upsertUiMessage({
          id: parsed.id,
          conversationId: parsed.chatId,
          role: parsed.role ?? 'system',
          authorId: parsed.authorId ?? 'web-ui',
          authorName: parsed.authorName ?? 'UI',
          createdAt: parsed.createdAt ?? new Date().toISOString(),
          kind: parsed.kind,
          content,
        }, parsed.preview)
        sendJson(res, 200, { ok: true })
      } catch (err) {
        sendJson(res, 500, { error: String(err) })
      }
      return
    }

    if (req.method === 'POST' && url === '/web/messages') {
      try {
        const body = await readBody(req)
        const parsed = JSON.parse(body) as {
          botId?: string
          botIds?: string[]
          chatId?: string
          text?: string
          userId?: string
          routeMode?: 'default' | 'direct_self'
          hiddenUserMessage?: boolean
        }
        const fallbackBotId = parsed.botId ?? (parsed.chatId ? store.getConversationBot(parsed.chatId) : null)
        const requestedBotIds = [...new Set((parsed.botIds?.length ? parsed.botIds : [fallbackBotId]).filter((id): id is string => Boolean(id)))]
          .filter((id) => knownBotIds.has(id))
        const botIds = parsed.routeMode === 'direct_self' && requestedBotIds.length > 1
          ? orderGroupBotIds(requestedBotIds)
          : requestedBotIds
        if (botIds.length === 0 || !parsed.chatId || !parsed.text) {
          sendJson(res, 400, { error: 'botId or known chatId, chatId, text are required' })
          return
        }
        const webHistory = parsed.routeMode === 'direct_self'
          ? []
          : webMessagesToHistory(store.listMessages(parsed.chatId))
        const userMessageId = randomUUID()
        if (!parsed.hiddenUserMessage) {
          store.addUserMessage({
            id: userMessageId,
            chatId: parsed.chatId,
            userId: parsed.userId ?? 'web-user',
            authorName: 'Me',
            text: parsed.text,
          })
        }
        const scheduledTask = registerCronTask(store, {
          chatId: parsed.chatId,
          botIds,
          text: parsed.text,
        })
        const messageIds = botIds.map((botId, index) => ({
          botId,
          messageId: manager.sendWebMessage(
            botId,
            parsed.chatId!,
            parsed.userId ?? 'web-user',
            parsed.text!,
            parsed.routeMode ?? 'default',
            parsed.routeMode === 'direct_self' && botIds.length > 1 ? index * 3500 : 0,
            webHistory,
          ),
        }))
        sendJson(res, 200, { messageId: messageIds[0]?.messageId, messageIds, scheduledTask, userMessageId })
      } catch (err) {
        sendJson(res, 500, { error: String(err) })
      }
      return
    }

    sendJson(res, 404, { error: 'Not found' })
  })

  server.on('close', () => stopCronScheduler())

  // ── WebSocket: live event stream ─────────────────────────────────────────
  const wss = new WebSocketServer({ server, path: '/web/stream' })

  wss.on('connection', (ws: WebSocket) => {
    logger.info('Web IM client connected')

    const listener: WebEventListener = (event: WebEvent) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(event))
      }
    }
    const unsubscribe = manager.subscribeWeb(listener)

    // On connect, push current agent statuses so client can hydrate immediately
    for (const snap of manager.listSnapshots()) {
      listener({ type: 'agent_status', botId: snap.botId, status: snap.status })
    }

    ws.on('close', () => {
      unsubscribe()
      logger.info('Web IM client disconnected')
    })

    ws.on('error', (err) => {
      logger.warn(`Web IM ws error: ${err}`)
    })

    // Keep-alive ping every 30s
    const pingTimer = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.ping()
    }, 30_000)
    ws.on('close', () => clearInterval(pingTimer))
  })

  server.listen(port)
  return server
}
