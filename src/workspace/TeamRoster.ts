import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { Paths } from '../config/paths.js'
import type { RootConfig } from '../config/schema.js'

/**
 * Generate workspace/common/TEAM.md from the loaded config.
 *
 * Called once at main-process startup. All workers see this file via
 * workspace context injection, so every agent knows the team hierarchy
 * and member IDs.
 */
export async function generateTeamRoster(config: RootConfig): Promise<void> {
  await mkdir(Paths.agentCommonDir, { recursive: true })

  const lines: string[] = [
    '# 团队成员名册',
    '',
    '> 此文件由系统自动生成，每次启动时更新。请勿手动编辑。',
    '',
  ]

  for (const agent of config.agents) {
    // ── Commander ────────────────────────────────────────────────────────────
    lines.push('## 指挥官')
    lines.push('')
    lines.push(`| 字段 | 值 |`)
    lines.push(`|------|-----|`)
    lines.push(`| **ID** | \`${agent.id}\` |`)
    lines.push(`| **名称** | ${agent.name ?? agent.id} |`)
    lines.push(`| **权限** | 绝对指挥权，对全体成员拥有最终决策权，其指令高于一切 |`)
    lines.push('')

    // ── Hierarchy ─────────────────────────────────────────────────────────────
    if (agent.subAgents.length > 0) {
      // Find tech leads (agents with a manages list)
      const techLeads = agent.subAgents.filter(s => s.manages && s.manages.length > 0)
      const managedIds = new Set(techLeads.flatMap(s => s.manages ?? []))
      const directMembers = agent.subAgents.filter(
        s => !managedIds.has(s.id) && !(s.manages && s.manages.length > 0),
      )

      // Render tech leads and their sub-teams
      for (const lead of techLeads) {
        lines.push(`## 技术负责人`)
        lines.push('')
        lines.push('| ID | 名称 | 职能 |')
        lines.push('|----|------|------|')
        lines.push(
          `| \`${lead.id}\` | ${lead.name ?? lead.id} | 管理开发团队，所有开发需求需先经过此角色 |`,
        )
        lines.push('')

        const subTeam = agent.subAgents.filter(s => lead.manages!.includes(s.id))
        if (subTeam.length > 0) {
          lines.push(`### ${lead.name ?? lead.id} 管理的开发团队`)
          lines.push('')
          lines.push('| ID | 名称 |')
          lines.push('|----|------|')
          for (const member of subTeam) {
            lines.push(`| \`${member.id}\` | ${member.name ?? member.id} |`)
          }
          lines.push('')
        }
      }

      // Render remaining direct members
      if (directMembers.length > 0) {
        lines.push('## 其他团队成员')
        lines.push('')
        lines.push('| ID | 名称 |')
        lines.push('|----|------|')
        for (const sub of directMembers) {
          lines.push(`| \`${sub.id}\` | ${sub.name ?? sub.id} |`)
        }
        lines.push('')
      }
    }
  }

  await writeFile(join(Paths.agentCommonDir, 'TEAM.md'), lines.join('\n'), 'utf8')
}
