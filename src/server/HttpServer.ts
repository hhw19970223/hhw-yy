import { createServer, type Server } from 'http'
import type { Manager } from '../process/Manager.js'

/**
 * Minimal HTTP server exposing health and bot status endpoints.
 *
 * Routes:
 *   GET /health          → { status: "ok", uptime: <seconds> }
 *   GET /bots            → BotSnapshot[]
 *   GET /bots/:botId     → BotSnapshot | 404
 */
export function startHttpServer(manager: Manager, port: number): Server {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')

    if (req.method !== 'GET') {
      res.writeHead(405)
      res.end(JSON.stringify({ error: 'Method not allowed' }))
      return
    }

    const url = req.url ?? '/'

    if (url === '/health') {
      res.writeHead(200)
      res.end(JSON.stringify({ status: 'ok', uptime: Math.floor(process.uptime()) }))
      return
    }

    if (url === '/bots') {
      res.writeHead(200)
      res.end(JSON.stringify(manager.listSnapshots()))
      return
    }

    const botMatch = url.match(/^\/bots\/([^/?]+)$/)
    if (botMatch) {
      const botId = decodeURIComponent(botMatch[1])
      const snapshot = manager.getSnapshot(botId)
      if (!snapshot) {
        res.writeHead(404)
        res.end(JSON.stringify({ error: `Bot "${botId}" not found` }))
        return
      }
      res.writeHead(200)
      res.end(JSON.stringify(snapshot))
      return
    }

    res.writeHead(404)
    res.end(JSON.stringify({ error: 'Not found' }))
  })

  server.listen(port)
  return server
}
