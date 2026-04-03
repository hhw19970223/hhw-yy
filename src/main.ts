/**
 * hhw-yy gateway service entry point.
 *
 * Usage:
 *   node dist/main.js [config.json]
 *   CONFIG_PATH=/path/to/config.json node dist/main.js
 *
 * Default config path: ./config.json (relative to cwd)
 */
import { loadRootConfig } from './config/loader.js'
import { Gateway } from './gateway/Gateway.js'
import { Manager, type HeartbeatConfig } from './process/Manager.js'
import { startMcpServer } from './mcp/server.js'
import { startHttpServer } from './server/HttpServer.js'
import { logger, setupErrorLog, setProcessLabel } from './shared/logger.js'

async function main(): Promise<void> {
  const configArg = process.argv[2] ?? 'config.json'
  const config = await loadRootConfig(configArg)

  setProcessLabel('gateway')
  setupErrorLog('error')

  logger.info(
    `Starting hhw-yy gateway: ${config.agents.length} agent(s), HTTP port ${config.gateway.port}`,
  )

  // ── Gateway: open one Feishu WebSocket connection per bot ──────────────────
  const gateway = new Gateway()

  for (const agent of config.agents) {
    gateway.registerBot(agent.id, agent.feishu, agent.behavior.chunkSize)
    for (const sa of agent.subAgents) {
      gateway.registerBot(sa.id, sa.feishu, sa.behavior.chunkSize)
    }
  }

  await gateway.startAll()

  // ── Manager: fork one worker process per bot ───────────────────────────────
  const heartbeat: HeartbeatConfig = {
    intervalMs: config.gateway.heartbeatIntervalMs,
    timeoutMs: config.gateway.heartbeatTimeoutMs,
  }
  const manager = new Manager(gateway, heartbeat)

  for (const agent of config.agents) {
    await manager.startMainAgent(agent)
  }

  // ── HTTP status server ─────────────────────────────────────────────────────
  const httpServer = startHttpServer(manager, config.gateway.port)
  logger.info(`HTTP server listening on port ${config.gateway.port}`)

  // ── MCP server (stdio transport — for Claude Code integration) ─────────────
  startMcpServer(manager)
  logger.info('MCP server started on stdio')

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down...`)
    try {
      manager.stopHeartbeat()
      await manager.stopAll()
      await gateway.stopAll()
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
