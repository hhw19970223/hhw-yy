import { readFile } from 'fs/promises'
import { resolve, relative } from 'path'
import { ClaudeClient } from '../llm/ClaudeClient.js'
import { loadAgentPrompt } from '../config/agentPrompt.js'
import type { Manager } from '../process/Manager.js'
import { listSkills, type SkillDefinition } from './SkillCatalog.js'

export type SkillParamFieldType = 'input' | 'textarea' | 'number' | 'select'

export interface SkillParamField {
  id: string
  label: string
  type: SkillParamFieldType
  required: boolean
  placeholder?: string
  options?: Array<{ label: string; value: string }>
}

export interface SkillAnalysisResult {
  skill: SkillDefinition
  agentId: string
  agentName: string
  analysisSummary: string
  fields: SkillParamField[]
}

interface RawAnalysis {
  analysisSummary?: unknown
  fields?: unknown
}

const FIELD_TYPES = new Set<SkillParamFieldType>(['input', 'textarea', 'number', 'select'])

export async function analyzeSkillParams(input: {
  manager: Manager
  botId: string
  skillId: string
}): Promise<SkillAnalysisResult> {
  const botConfig = input.manager.getBotConfig(input.botId)
  if (!botConfig) throw new Error(`Bot ${input.botId} not found`)

  const skills = await listSkills()
  const skill = skills.find((item) => item.id === input.skillId || item.path === input.skillId)
  if (!skill) throw new Error(`Skill ${input.skillId} not found`)

  const root = process.cwd()
  const skillPath = resolve(root, skill.path)
  const rel = relative(root, skillPath)
  if (rel.startsWith('..')) throw new Error('Skill path escapes project root')
  const skillMarkdown = await readFile(skillPath, 'utf8')

  const apiKey = botConfig.claude.apiKey ?? process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error(`Bot ${input.botId} has no Claude API key`)

  const systemPrompt = await loadAgentPrompt(input.botId)
  const client = new ClaudeClient({
    apiKey,
    baseUrl: botConfig.claude.baseUrl,
    model: botConfig.claude.model,
    maxTokens: Math.min(botConfig.claude.maxTokens ?? 8192, 2048),
    systemPrompt: [
      systemPrompt,
      '',
      '你现在只负责把一个 SKILL.md 分析成前端参数表单 schema。',
      '必须只输出 JSON，不要输出 Markdown、解释、代码块或多余文字。',
    ].join('\n'),
  })

  const prompt = [
    '请分析下面的 SKILL.md，提取用户在执行前必须提供或建议提供的参数。',
    '',
    '输出 JSON 格式：',
    '{',
    '  "analysisSummary": "一句话说明你为什么需要这些参数",',
    '  "fields": [',
    '    {',
    '      "id": "snake_case_id",',
    '      "label": "中文字段名",',
    '      "type": "input | textarea | number | select",',
    '      "required": true,',
    '      "placeholder": "填写提示",',
    '      "options": [{"label":"选项名","value":"option_value"}]',
    '    }',
    '  ]',
    '}',
    '',
    '约束：',
    '- fields 数量 2 到 8 个。',
    '- 每个 skill 至少包含一个 required=true 的目标/任务描述字段。',
    '- type 只能是 input、textarea、number、select。',
    '- select 必须提供 options；非 select 不要提供 options。',
    '- required 表示缺少该参数时无法可靠执行。',
    '- 不要要求用户提供 skill 路径、当前会话 id、agent id 这类系统已知信息。',
    '- 如果 skill 涉及发送、发布、删除、付费、外部触达，必须提取确认/约束类参数。',
    '',
    `Skill 元数据：${JSON.stringify(skill)}`,
    '',
    'SKILL.md：',
    skillMarkdown.slice(0, 30_000),
  ].join('\n')

  const result = await client.chat([], prompt)
  const parsed = parseJson(result.text)
  const normalized = normalizeAnalysis(parsed)

  return {
    skill,
    agentId: input.botId,
    agentName: botConfig.name ?? input.botId,
    analysisSummary: normalized.analysisSummary,
    fields: normalized.fields,
  }
}

function parseJson(text: string): RawAnalysis {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed) as RawAnalysis
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/)
    if (!match) throw new Error(`Skill analysis did not return JSON: ${trimmed.slice(0, 200)}`)
    return JSON.parse(match[0]) as RawAnalysis
  }
}

function normalizeAnalysis(raw: RawAnalysis): { analysisSummary: string; fields: SkillParamField[] } {
  const summary = typeof raw.analysisSummary === 'string' && raw.analysisSummary.trim()
    ? raw.analysisSummary.trim().slice(0, 240)
    : 'Agent 已根据该 skill 提取出执行前需要确认的参数。'
  if (!Array.isArray(raw.fields)) throw new Error('Skill analysis missing fields[]')

  const fields: SkillParamField[] = raw.fields
    .map((item, index): SkillParamField | null => {
      if (!item || typeof item !== 'object') return null
      const obj = item as Record<string, unknown>
      const type = FIELD_TYPES.has(obj.type as SkillParamFieldType)
        ? obj.type as SkillParamFieldType
        : 'input'
      const id = safeId(typeof obj.id === 'string' ? obj.id : `field_${index + 1}`)
      const label = typeof obj.label === 'string' && obj.label.trim()
        ? obj.label.trim().slice(0, 40)
        : `参数 ${index + 1}`
      const field: SkillParamField = {
        id,
        label,
        type,
        required: Boolean(obj.required),
      }
      if (typeof obj.placeholder === 'string') field.placeholder = obj.placeholder.slice(0, 160)
      if (type === 'select') {
        const options = Array.isArray(obj.options) ? obj.options : []
        field.options = options
          .map((option): { label: string; value: string } | null => {
            if (!option || typeof option !== 'object') return null
            const optionObj = option as Record<string, unknown>
            const optionLabel = typeof optionObj.label === 'string' ? optionObj.label.trim() : ''
            const optionValue = typeof optionObj.value === 'string' ? optionObj.value.trim() : ''
            if (!optionLabel || !optionValue) return null
            return { label: optionLabel.slice(0, 40), value: optionValue.slice(0, 80) }
          })
          .filter((option): option is { label: string; value: string } => Boolean(option))
        if (field.options.length === 0) field.type = 'input'
      }
      return field
    })
    .filter((field): field is SkillParamField => Boolean(field))
    .slice(0, 8)

  if (fields.length < 2) throw new Error('Skill analysis returned too few fields')
  if (!fields.some((field) => field.required)) fields[0].required = true
  return { analysisSummary: summary, fields }
}

function safeId(value: string): string {
  const id = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  return id || 'field'
}
