import { z } from 'zod'

// ─── Shared inner schemas ────────────────────────────────────────────────────

const FeishuConfigSchema = z.object({
  appId: z.string().min(1, 'feishu.appId is required'),
  appSecret: z.string().min(1, 'feishu.appSecret is required'),
  encryptKey: z.string().optional(),
  verificationToken: z.string().optional(),
})

const ClaudeConfigSchema = z
  .object({
    apiKey: z.string().optional(),
    baseUrl: z.string().url().optional(),
    model: z.string().default('claude-opus-4-6'),
    maxTokens: z.number().int().positive().default(2048),
    historyLimit: z.number().int().positive().default(20),
  })
  .default({})

const AccessConfigSchema = z
  .object({
    dmPolicy: z.enum(['open', 'allowlist', 'disabled']).default('open'),
    groupPolicy: z.enum(['open', 'allowlist', 'disabled']).default('open'),
    requireMention: z.boolean().default(true),
    /** Respond even when @所有人 / @all is used (only relevant when requireMention is true) */
    respondToMentionAll: z.boolean().default(true),
    allowFrom: z.array(z.string()).default([]),
    denyFrom: z.array(z.string()).default([]),
  })
  .default({})

const BehaviorConfigSchema = z
  .object({
    replyMode: z.enum(['text', 'card']).default('text'),
    chunkSize: z.number().int().positive().default(4000),
    typingIndicator: z.boolean().default(true),
    persistHistory: z.boolean().default(false),
    injectWorkspaceContext: z.boolean().default(true),
    /** Enable agentic tool use (Feishu Bitable CRUD tools) */
    enableTools: z.boolean().default(false),
    /** After each reply, run a lightweight Claude call to extract memorable facts into daily notes */
    memoryExtraction: z.boolean().default(false),
  })
  .default({})

// ─── Gateway config ──────────────────────────────────────────────────────────

export const GatewayConfigSchema = z
  .object({
    /** HTTP server port for health / status API */
    port: z.number().int().positive().default(3000),
    /** How often to send PING to each worker process (ms) */
    heartbeatIntervalMs: z.number().int().positive().default(15_000),
    /** How long to wait for PONG before declaring a worker unresponsive (ms) */
    heartbeatTimeoutMs: z.number().int().positive().default(5_000),
  })
  .default({})

// ─── Sub-agent config ────────────────────────────────────────────────────────

const SubAgentConfigSchema = z.object({
  id: z.string().min(1, 'subAgent.id is required'),
  name: z.string().optional(),
  /** Optional per-agent HTTP admin port */
  port: z.number().int().positive().optional(),
  feishu: FeishuConfigSchema,
  claude: ClaudeConfigSchema,
  access: AccessConfigSchema,
  behavior: BehaviorConfigSchema,
  /**
   * IDs of sibling sub-agents this agent leads / manages.
   * Used to render team hierarchy in workspace/common/TEAM.md.
   */
  manages: z.array(z.string()).optional(),
})

// ─── Main agent config ───────────────────────────────────────────────────────

export const MainAgentConfigSchema = z.object({
  /** Unique identifier for this main agent */
  id: z.string().min(1, 'agent id is required'),
  name: z.string().optional(),
  /** Optional per-agent HTTP admin port */
  port: z.number().int().positive().optional(),
  feishu: FeishuConfigSchema,
  claude: ClaudeConfigSchema,
  access: AccessConfigSchema,
  behavior: BehaviorConfigSchema,
  subAgents: z.array(SubAgentConfigSchema).min(1, 'At least one subAgent is required'),
})

// ─── Root service config ─────────────────────────────────────────────────────

export const RootConfigSchema = z.object({
  gateway: GatewayConfigSchema,
  agents: z.array(MainAgentConfigSchema).min(1, 'At least one agent is required'),
})

// ─── Inferred types ──────────────────────────────────────────────────────────

export type SubAgentConfig = z.infer<typeof SubAgentConfigSchema>
export type MainAgentConfig = z.infer<typeof MainAgentConfigSchema>
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>
export type RootConfig = z.infer<typeof RootConfigSchema>

/** Sub-agent config enriched with runtime context */
export interface LoadedSubAgentConfig extends SubAgentConfig {
  /** Main agent that owns this sub-agent */
  mainAgentId: string
  /** Path to the root config file */
  configPath: string
}

/** Main agent config enriched with runtime context */
export interface LoadedMainAgentConfig extends MainAgentConfig {
  /** = config.id */
  mainAgentId: string
  /** Path to the root config file */
  configPath: string
}

/** Root config enriched with runtime context */
export interface LoadedRootConfig extends Omit<RootConfig, 'agents'> {
  agents: LoadedMainAgentConfig[]
  configPath: string
}
