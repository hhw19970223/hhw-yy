import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const botId = process.env.SL_BOT_ID ?? ''
const port = process.env.SL_HTTP_PORT ?? '4000'

const server = new Server(
  { name: 'SL Agent Tools', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

interface SearchResult {
  title: string
  url: string
  snippet: string
}

async function duckDuckGoSearch(query: string, limit: number): Promise<SearchResult[]> {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SL-Agent/0.1; +https://localhost)',
      Accept: 'text/html,application/xhtml+xml',
    },
  })
  if (!response.ok) throw new Error(`DuckDuckGo returned ${response.status}`)
  const html = await response.text()
  const results: SearchResult[] = []
  const blocks = html.split(/<div class="result\b/i).slice(1)
  for (const block of blocks) {
    const linkMatch = block.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!linkMatch) continue
    const rawUrl = decodeHtml(linkMatch[1] ?? '')
    const resultUrl = normalizeDuckDuckGoUrl(rawUrl)
    const title = cleanHtml(linkMatch[2] ?? '')
    const snippetMatch = block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i) ??
      block.match(/<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i)
    const snippet = cleanHtml(snippetMatch?.[1] ?? '')
    if (title && resultUrl) results.push({ title, url: resultUrl, snippet })
    if (results.length >= limit) break
  }
  return results
}

async function fetchReadableUrl(url: string, maxChars: number): Promise<{
  url: string
  status: number
  contentType: string
  title: string
  text: string
}> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SL-Agent/0.1; +https://localhost)',
      Accept: 'text/html,text/plain,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5',
    },
    redirect: 'follow',
  })
  const contentType = response.headers.get('content-type') ?? ''
  const body = await response.text()
  const isHtml = /html|xml/i.test(contentType) || /<\/?[a-z][\s\S]*>/i.test(body.slice(0, 500))
  const title = isHtml ? cleanHtml(body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '') : ''
  const text = isHtml ? htmlToText(body) : body
  return {
    url: response.url || url,
    status: response.status,
    contentType,
    title,
    text: text.slice(0, maxChars),
  }
}

function normalizeDuckDuckGoUrl(value: string): string {
  try {
    const parsed = new URL(value, 'https://duckduckgo.com')
    const uddg = parsed.searchParams.get('uddg')
    if (uddg) return uddg
    return parsed.href
  } catch {
    return value
  }
}

function htmlToText(html: string): string {
  return cleanHtml(html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n'))
}

function cleanHtml(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'delegate_to_agent',
      description:
        'Delegate a task to another SL Agent. The target Agent will answer in the same current chat/task. ' +
        'Use chat_id from <current_session> and target_bot_id from the team roster.',
      inputSchema: {
        type: 'object',
        properties: {
          target_bot_id: {
            type: 'string',
            description: 'Target Agent ID, for example KOL增长, SEO内容, 社媒分发, 运营经理.',
          },
          message: {
            type: 'string',
            description: 'Clear delegation brief including context, expected output, and constraints.',
          },
          chat_id: {
            type: 'string',
            description: 'Current chat/task ID from <current_session>.',
          },
        },
        required: ['target_bot_id', 'message', 'chat_id'],
      },
    },
    {
      name: 'create_scheduled_task',
      description:
        'Create a global scheduled task visible in the SL right-side board. ' +
        'Use this when the user asks to start, create, add, or schedule a recurring task.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: {
            type: 'string',
            description: 'Current chat/task ID from <current_session>.',
          },
          cron: {
            type: 'string',
            description: 'Five-field cron expression, for example */5 * * * * or 0 9 * * *.',
          },
          prompt: {
            type: 'string',
            description: 'Task prompt to run whenever the schedule fires.',
          },
          title: {
            type: 'string',
            description: 'Short display name for the scheduled task.',
          },
          bot_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional target Agent IDs. Defaults to the current Agent.',
          },
        },
        required: ['chat_id', 'cron', 'prompt'],
      },
    },
    {
      name: 'delete_scheduled_task',
      description: 'Delete a global scheduled task by ID.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Scheduled task ID shown in the right-side board.',
          },
        },
        required: ['id'],
      },
    },
    {
      name: 'WebSearch',
      description:
        'Search the web using DuckDuckGo and return concise search results with title, URL and snippet. ' +
        'Use this when current or external information is needed.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return. Defaults to 5, max 10.',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'WebFetch',
      description:
        'Fetch a URL and return readable text content. Use this after WebSearch when a source needs to be opened.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'HTTP or HTTPS URL to fetch.',
          },
          max_chars: {
            type: 'number',
            description: 'Maximum characters to return. Defaults to 12000, max 30000.',
          },
        },
        required: ['url'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'WebSearch') {
    const input = request.params.arguments as { query?: unknown; limit?: unknown }
    const query = typeof input.query === 'string' ? input.query.trim() : ''
    const limit = typeof input.limit === 'number' ? Math.min(Math.max(Math.floor(input.limit), 1), 10) : 5
    if (!query) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'query is required' }) }],
        isError: true,
      }
    }
    try {
      const results = await duckDuckGoSearch(query, limit)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ query, results }, null, 2) }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
        isError: true,
      }
    }
  }

  if (request.params.name === 'WebFetch') {
    const input = request.params.arguments as { url?: unknown; max_chars?: unknown }
    const url = typeof input.url === 'string' ? input.url.trim() : ''
    const maxChars = typeof input.max_chars === 'number'
      ? Math.min(Math.max(Math.floor(input.max_chars), 1000), 30_000)
      : 12_000
    if (!/^https?:\/\//i.test(url)) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'valid http(s) url is required' }) }],
        isError: true,
      }
    }
    try {
      const fetched = await fetchReadableUrl(url, maxChars)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(fetched, null, 2) }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
        isError: true,
      }
    }
  }

  if (request.params.name === 'create_scheduled_task') {
    const input = request.params.arguments as {
      chat_id?: unknown
      cron?: unknown
      prompt?: unknown
      title?: unknown
      bot_ids?: unknown
    }
    const chatId = typeof input.chat_id === 'string' ? input.chat_id.trim() : ''
    const cron = typeof input.cron === 'string' ? input.cron.trim() : ''
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    const botIds = Array.isArray(input.bot_ids)
      ? input.bot_ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : [botId]

    if (!botId || !chatId || !cron || !prompt) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: 'SL_BOT_ID, chat_id, cron and prompt are required' }),
        }],
        isError: true,
      }
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/internal/scheduled-tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, botIds, cron, prompt, title }),
      })
      const text = await response.text()
      return {
        content: [{ type: 'text' as const, text }],
        isError: !response.ok,
      }
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
        isError: true,
      }
    }
  }

  if (request.params.name === 'delete_scheduled_task') {
    const input = request.params.arguments as { id?: unknown }
    const id = typeof input.id === 'string' ? input.id.trim() : ''
    if (!id) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'id is required' }) }],
        isError: true,
      }
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/web/scheduled-tasks/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      const text = await response.text()
      return {
        content: [{ type: 'text' as const, text: text || JSON.stringify({ ok: true }) }],
        isError: !response.ok,
      }
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
        isError: true,
      }
    }
  }

  if (request.params.name !== 'delegate_to_agent') {
    return {
      content: [{ type: 'text' as const, text: `Unknown tool: ${request.params.name}` }],
      isError: true,
    }
  }

  const input = request.params.arguments as {
    target_bot_id?: unknown
    message?: unknown
    chat_id?: unknown
  }
  const targetBotId = typeof input.target_bot_id === 'string' ? input.target_bot_id.trim() : ''
  const message = typeof input.message === 'string' ? input.message.trim() : ''
  const chatId = typeof input.chat_id === 'string' ? input.chat_id.trim() : ''

  if (!botId || !targetBotId || !message || !chatId) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: 'SL_BOT_ID, target_bot_id, message and chat_id are required' }),
      }],
      isError: true,
    }
  }

  try {
    const response = await fetch(`http://127.0.0.1:${port}/internal/delegate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromBotId: botId,
        targetBotId,
        chatId,
        message,
      }),
    })
    const text = await response.text()
    return {
      content: [{ type: 'text' as const, text }],
      isError: !response.ok,
    }
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
      isError: true,
    }
  }
})

await server.connect(new StdioServerTransport())
