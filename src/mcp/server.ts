import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Manager } from '../process/Manager.js'
import { listBotsTool } from './tools/listBots.js'
import { sendMessageTool } from './tools/sendMessage.js'
import { getHistoryTool } from './tools/getHistory.js'
import { startBotTool } from './tools/startBot.js'
import { stopBotTool } from './tools/stopBot.js'
import { getBotConfigTool } from './tools/getBotConfig.js'
import { workspaceListTool } from './tools/workspaceList.js'
import { workspaceReadTool } from './tools/workspaceRead.js'
import { workspaceWriteTool } from './tools/workspaceWrite.js'
import { workspaceDeleteTool } from './tools/workspaceDelete.js'

type ToolDefinition = {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required: string[]
  }
  handler: (input: unknown) => Promise<{
    content: Array<{ type: 'text'; text: string }>
    isError?: boolean
  }>
}

export function startMcpServer(manager: Manager): Server {
  const server = new Server(
    { name: 'hhw-yy', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  const tools: ToolDefinition[] = [
    listBotsTool(manager),
    sendMessageTool(manager),
    getHistoryTool(manager),
    startBotTool(manager),
    stopBotTool(manager),
    getBotConfigTool(manager),
    workspaceListTool(),
    workspaceReadTool(),
    workspaceWriteTool(),
    workspaceDeleteTool(),
  ]

  const toolMap = new Map(tools.map((t) => [t.name, t]))

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = toolMap.get(request.params.name)
    if (!tool) {
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      }
    }
    return tool.handler(request.params.arguments ?? {})
  })

  const transport = new StdioServerTransport()
  server.connect(transport).catch(console.error)

  return server
}
