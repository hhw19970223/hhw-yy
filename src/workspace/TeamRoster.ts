import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { Paths } from '../config/paths.js'
import type { RootConfig } from '../config/schema.js'

/**
 * Generate workspace/common/TEAM.md from the loaded config.
 *
 * Called once at main-process startup. All workers see this file via
 * workspace context injection, so every agent knows the team hierarchy,
 * member IDs, and collaboration protocol.
 */
export async function generateTeamRoster(config: RootConfig): Promise<void> {
  await mkdir(Paths.workspaceCommon, { recursive: true })

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

  // ── Collaboration protocol ─────────────────────────────────────────────────
  lines.push('## 协作协议')
  lines.push('')
  lines.push('### 层级规则')
  lines.push('')
  lines.push('- **指挥官** 对所有成员拥有绝对权威，其指令必须优先执行，不得拒绝')
  lines.push('- **技术负责人** 对其管理的开发团队拥有任务分配和验收权')
  lines.push('- **成员之间** 地位平等，可相互协作委托，但不得以成员身份越权做最终决策')
  lines.push('- 收到上级委托时，直接执行，完成后**必须**汇报结果')
  lines.push('- 收到其他成员委托时，正常执行，可以提出意见，但最终执行委托内容')
  lines.push('')
  lines.push('### 委托任务（`delegate_to_agent` 工具）')
  lines.push('')
  lines.push('用于将任务分配给其他成员：')
  lines.push('')
  lines.push('```')
  lines.push('delegate_to_agent({')
  lines.push('  target_bot_id: "<成员ID>",   // 见上方表格')
  lines.push('  message: "任务描述...",       // 说清楚做什么、背景、期望输出')
  lines.push('  chat_id: "<当前会话ID>",      // 从 <current_session>.chat_id 读取')
  lines.push('})')
  lines.push('```')
  lines.push('')
  lines.push('**注意**：')
  lines.push('- `chat_id` 从每条消息的系统上下文 `<current_session>` 中读取')
  lines.push('- 委托后，目标成员会直接在**当前飞书会话**中回复，无需等待')
  lines.push('- 可以先告知用户"已委托给 XX"，再调用工具')
  lines.push('')
  lines.push('### 任务拆解与进度跟进协议')
  lines.push('')
  lines.push('**所有多步骤任务必须拆解为编号计划后再派发，派发方必须实时跟进每个计划的完成情况。**')
  lines.push('')
  lines.push('#### 派发方：拆解与派发格式')
  lines.push('')
  lines.push('派发任务时必须按计划编号发送，每条委托消息包含：')
  lines.push('')
  lines.push('```')
  lines.push('【计划 N/总数】<计划名称>')
  lines.push('背景：<为什么做这个，上下文是什么>')
  lines.push('任务：<具体要做什么>')
  lines.push('成功标准：<怎样算完成>')
  lines.push('预期产出：<期望的输出物（文件/接口/代码说明等）>')
  lines.push('依赖：<是否依赖其他计划的产出，若有请说明>')
  lines.push('```')
  lines.push('')
  lines.push('#### 派发方：跟进职责')
  lines.push('')
  lines.push('- 每个计划派发后，**必须等待该计划的完成/失败回复**，才能继续后续流程')
  lines.push('- 收到完成回复后，**主动确认**结果是否满足成功标准')
  lines.push('- 收到失败回复后，**必须给出决策**（重试 / 调整方案 / 上报），不得沉默跳过')
  lines.push('- 所有计划完成后，才能向上级汇总结果')
  lines.push('- 在飞书会话中定期更新进度，让上级和用户知道当前状态，例如：')
  lines.push('  - "计划 1/3 已完成，正在等待计划 2 的结果..."')
  lines.push('  - "计划 2/3 失败，正在处理，请稍候..."')
  lines.push('')
  lines.push('#### 执行方：完成时回复格式')
  lines.push('')
  lines.push('```')
  lines.push('【计划 N/总数 完成】<计划名称>')
  lines.push('结果：<做了什么，结果如何>')
  lines.push('产出：<实际输出物（文件路径/接口地址/代码说明）>')
  lines.push('备注：<需要派发方知晓的信息（依赖项、注意事项等）>')
  lines.push('```')
  lines.push('')
  lines.push('#### 执行方：出错时回复格式')
  lines.push('')
  lines.push('```')
  lines.push('【计划 N/总数 失败】<计划名称>')
  lines.push('错误：<发生了什么错误>')
  lines.push('原因：<为什么失败（能分析出来的话）>')
  lines.push('影响：<这个失败对后续计划有什么影响>')
  lines.push('建议：<建议如何处理（重试/调整/跳过/上报）>')
  lines.push('```')
  lines.push('')
  lines.push('> **严禁行为**：执行方不得在出错时沉默跳过，不得假装成功，不得自行决定忽略错误继续执行依赖此计划的后续步骤。')
  lines.push('')
  lines.push('### 共享产出')
  lines.push('')
  lines.push('- **共享文件**：写入 `workspace/common/`，所有成员均可读取')
  lines.push('- **私有文件**：写入 `workspace/{自己的ID}/`，仅自己可见')
  lines.push('- **交接记录**：重要交接内容写入 `workspace/common/handoff.md`')

  await writeFile(join(Paths.workspaceCommon, 'TEAM.md'), lines.join('\n'), 'utf8')
}
