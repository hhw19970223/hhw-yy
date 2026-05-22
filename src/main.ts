/**
 * SL gateway service entry point.
 *
 * Usage:
 *   node dist/main.js [config.json]
 *   CONFIG_PATH=/path/to/config.json node dist/main.js
 *
 * Default config path: ./config.json (relative to cwd)
 */
import { loadRootConfig } from './config/loader.js'
import { Manager, type HeartbeatConfig } from './process/Manager.js'
import { startMcpServer } from './mcp/server.js'
import { startHttpServer } from './server/HttpServer.js'
import { logger, setupErrorLog, setupDiagLog, setProcessLabel } from './shared/logger.js'
import { generateTeamRoster } from './workspace/TeamRoster.js'

async function main(): Promise<void> {
  const configArg = process.argv[2] ?? 'config.json'
  const config = await loadRootConfig(configArg)

  setProcessLabel('gateway')
  setupErrorLog('error')
  setupDiagLog('logs', true)   // truncate on each startup

  // Generate workspace/common/TEAM.md so all agents know the team hierarchy
  await generateTeamRoster(config)

  logger.info(
    `Starting SL gateway: ${config.agents.length} agent(s), HTTP port ${config.gateway.port}`,
  )

  // ── Manager: fork one worker process per bot.
  // Each worker now owns its Feishu WebSocket connection directly.
  const heartbeat: HeartbeatConfig = {
    intervalMs: config.gateway.heartbeatIntervalMs,
    timeoutMs: config.gateway.heartbeatTimeoutMs,
  }
  const manager = new Manager(heartbeat)

  for (const agent of config.agents) {
    await manager.startMainAgent(agent)
  }

  // ── HTTP + Web IM server ───────────────────────────────────────────────────
  const httpServer = startHttpServer(
    {
      manager,
      agents: config.agents,
      webConversations: config.web?.conversations ?? [],
    },
    config.gateway.port,
  )
  logger.info(`HTTP server listening on port ${config.gateway.port}`)

  // ── MCP server (stdio transport — for Claude Code integration) ─────────────
  if (process.env.SL_DISABLE_MCP === '1') {
    logger.info('MCP server disabled by SL_DISABLE_MCP')
  } else {
    startMcpServer(manager)
    logger.info('MCP server started on stdio')
  }

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down...`)
    try {
      manager.stopHeartbeat()
      await manager.stopAll()
      httpServer.close()
    } finally {
      process.exit(0)
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  console.error('Fatal startup error:', err)
  process.exit(1)
})
