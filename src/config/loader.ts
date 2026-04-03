import { readFile } from 'fs/promises'
import { resolve } from 'path'
import {
  RootConfigSchema,
  type LoadedMainAgentConfig,
  type LoadedRootConfig,
} from './schema.js'
import { ConfigError } from '../shared/errors.js'
import { logger } from '../shared/logger.js'

/**
 * Load and validate the root service config from a single JSON file.
 *
 * Config file path resolution order:
 *   1. Explicit argument
 *   2. CONFIG_PATH environment variable
 *   3. ./config.json (relative to cwd)
 */
export async function loadRootConfig(
  configPath = process.env.CONFIG_PATH ?? './config.json',
): Promise<LoadedRootConfig> {
  const absPath = resolve(configPath)

  let raw: string
  try {
    raw = await readFile(absPath, 'utf8')
  } catch (err) {
    throw new ConfigError(`Cannot read config file: ${absPath}: ${err}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new ConfigError(`Config file is not valid JSON: ${absPath}: ${err}`)
  }

  const result = RootConfigSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new ConfigError(`Invalid config file ${absPath}:\n${issues}`)
  }

  const agents: LoadedMainAgentConfig[] = result.data.agents.map((agent) => ({
    ...agent,
    mainAgentId: agent.id,
    configPath: absPath,
  }))

  logger.info(
    `Loaded ${agents.length} agent(s) from ${absPath}`,
  )
  for (const agent of agents) {
    logger.info(`  • ${agent.id} (${agent.subAgents.length} sub-agent(s))`, agent.id)
  }

  return {
    ...result.data,
    agents,
    configPath: absPath,
  }
}
