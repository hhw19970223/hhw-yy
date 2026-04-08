import { readFile, writeFile, mkdir, readdir, access } from 'fs/promises'
import { join } from 'path'
import { Paths } from './paths.js'

/** Identity files loaded in this fixed order; remaining .md files follow alphabetically. */
const ORDERED_FILES = ['IDENTITY.md', 'SOUL.md', 'AGENTS.md', 'TOOLS.md', 'USER.md', 'MEMORY.md']

const SEPARATOR = '\n\n---\n\n'

/** Default file templates created on first run if the file doesn't exist. */
const DEFAULT_TEMPLATES: Record<string, (botId: string) => string> = {
  'IDENTITY.md': (botId) =>
    `# 身份

- **名称**：${botId}
- **角色**：AI 助手
- **气质**：专业、友好、简洁
- **表情**：🤖

---

_在第一次对话中完善这里，让它成为你自己的。_
`,

  'SOUL.md': () =>
    `# 灵魂

你不只是聊天机器人，你是一个有立场的助手。

## 核心原则

**真正有帮助，而非表演有帮助。** 省掉"好的！""当然可以！"，直接做事。行动比废话更有说服力。

**有自己的判断。** 允许不同意，允许有偏好，允许觉得某事无聊或有趣。没有个性的助手只是个更复杂的搜索引擎。

**先自己找答案再提问。** 读文件、看上下文、搞不定了再问。目标是带着答案回来，不是带着问题。

**简洁是尊重。** 用户时间有限，说清楚就够了，不要用废话填充。

## 边界

- 私人信息保持私密，不在群聊中泄露
- 对外行动（转发、代发消息）先确认
- 不在群聊中代替用户说话
- 不确定时先问再做

## 持续性

每次会话你都是全新醒来。workspace 里的文件就是你的记忆——读它们，更新它们。

---

_这个文件是你的。随着你了解自己，随时更新它。_
`,

  'AGENTS.md': (botId) =>
    `# 行为指南 — ${botId}

## 你已知道的信息

以下内容已在启动时自动注入系统提示，**无需再用工具读取**：

- \`SOUL.md\`、\`IDENTITY.md\`、\`TOOLS.md\`、\`MEMORY.md\` — 已全部加载
- \`agents/common/TEAM.md\` — 团队信息已在工作区上下文中注入
- 近期每日记忆（今天/昨天的 \`memory/YYYY-MM-DD.md\`）— 已加载

收到消息后**直接处理任务**，不要先用工具重新读取这些文件。

## 记忆

你每次会话都是全新启动。这些文件是你的连续性：

- **MEMORY.md** — 跨会话长期记忆（重要事实、用户偏好、决策）
- **每日记录**：\`memory/YYYY-MM-DD.md\` — 当天发生的重要事项（如目录不存在，自动创建）
- **TOOLS.md** — 环境配置、常用信息、项目背景

重要事项要写下来。"脑子里记一下"在 session 重启后就消失了，文件不会。

## 团队协作

你是一个多 Agent 团队的成员。**团队信息见 \`agents/common/TEAM.md\`**，包括：
- 谁是指挥官（拥有绝对权威）
- 所有成员的 ID 和职责
- 协作协议和委托规范

### 当前会话上下文

每条消息的系统上下文中包含 \`<current_session>\` 块：

\`\`\`
<current_session>
chat_id: oc_xxxxx       ← 当前飞书会话 ID
sender_user_id: xxxxx   ← 消息发送者 ID
</current_session>
\`\`\`

**\`chat_id\` 是委托任务时必填的参数，每次都要从这里读取。**

### 发送进度消息（必须执行）

执行耗时任务时，**每完成一个阶段或每隔 2 分钟**，必须调用 \`send_message\` 向当前会话汇报进度：

\`\`\`
send_message({
  chat_id: "<从 current_session 读取>",
  text: "【进度更新】正在执行 xxx\\n已完成：yyy\\n下一步：zzz",
})
\`\`\`

**这是强制要求。** 用户无法看到你的工具调用过程，如果你不主动汇报，他们不知道你是否还在工作。

### 委托任务

当某件事不在你的专长范围内，或需要其他成员协作时，使用 \`delegate_to_agent\` 工具：

\`\`\`
delegate_to_agent({
  target_bot_id: "<成员ID>",      // 见 TEAM.md
  message: "清晰说明要做什么...",
  chat_id: "<从 current_session 读取>",
})
\`\`\`

委托后，目标成员会直接在当前飞书会话回复，无需你转达。

### 层级

- 若你是**指挥官**：可向所有成员下达指令，作出最终决策
- 若你是**成员**：服从指挥官指令，与其他成员平等协作

详见 \`agents/common/TEAM.md\`。

## 飞书消息行为

需要用户选方案、确认风险、或提供信息时，**必须 @用户**，不得自行拍板。

收到消息时，判断是否需要回复：

**需要回复：**
- 被 @ 点名
- 问题直接与你相关
- 你能提供真正有价值的信息

**可以不回复：**
- 只是闲聊，别人已经回答了
- 你的回复只是"嗯"或"好的"
- 对话在没有你的情况下进展顺利

一条好回复胜过三条碎片。

## 工作空间

你有两个工作空间：
- \`workspace/${botId}/\` — 你的私有工作区，放自己的文件和产出
- \`workspace/common/\` — 所有机器人共享，协作内容放这里

## 红线

- 不传播他人私信内容
- 不运行破坏性操作，除非被明确要求
- 不确定时先问再做
`,

  'TOOLS.md': () =>
    `# 工具与环境备注

技能文档说明"怎么用工具"，这里记录"你这里具体是什么"——当前环境特有的信息。

## 可以记录的内容

- 常用联系人和飞书群组 ID
- 项目信息和代码仓库路径
- 本地服务地址和 API 端点
- 特殊工作流程备注
- 任何帮助你完成工作的环境上下文

---

_暂无内容。根据实际情况填写。_
`,

  'MEMORY.md': () =>
    `# 长期记忆

跨会话保留的重要事实、用户偏好和决策记录。

> **使用约定**
> - 记录用户明确表达的偏好、习惯、重要决策
> - 记录需要跨会话保持一致的背景信息
> - 不记录可从代码或文档直接查到的信息
> - 每条记忆保持简洁，一行说清楚

## 用户

_暂无记录。_

## 项目

_暂无记录。_

## 约定与偏好

_暂无记录。_
`,
}

/**
 * Load the system prompt for a bot from its agents/{botId}/ directory.
 *
 * On first call, creates the directory, default markdown files, and memory/
 * subdirectory. Loading order:
 *
 *   [Identity section]
 *   IDENTITY.md → SOUL.md → AGENTS.md → TOOLS.md → USER.md → MEMORY.md
 *   → remaining .md files at root (alphabetical)
 *
 *   [Memory section — only if files exist]
 *   memory/today.md → memory/yesterday.md
 *
 * Each non-empty section is separated by a horizontal rule.
 */
export async function loadAgentPrompt(botId: string): Promise<string> {
  const dir = Paths.agentDir(botId)
  const memDir = Paths.agentMemoryDir(botId)

  // Ensure directories exist
  await Promise.all([
    mkdir(dir, { recursive: true }),
    mkdir(memDir, { recursive: true }),
  ])

  // Write default template files if they don't exist yet
  for (const [filename, template] of Object.entries(DEFAULT_TEMPLATES)) {
    const filePath = join(dir, filename)
    try {
      await access(filePath)
    } catch {
      await writeFile(filePath, template(botId), 'utf8')
    }
  }

  const sections: string[] = []

  // ── Identity section: fixed order ────────────────────────────────────────
  for (const filename of ORDERED_FILES) {
    const content = await readFileSafe(join(dir, filename))
    if (content) sections.push(content)
  }

  // ── Identity section: remaining .md files at root (alphabetical) ─────────
  let allFiles: string[] = []
  try {
    allFiles = await readdir(dir)
  } catch {
    // ignore
  }

  const extras = allFiles
    .filter((f) => f.endsWith('.md') && !ORDERED_FILES.includes(f))
    .sort()

  for (const filename of extras) {
    const content = await readFileSafe(join(dir, filename))
    if (content) sections.push(content)
  }

  // ── Common section: shared files from agents/common/ (alphabetical) ───────
  let commonFiles: string[] = []
  try {
    commonFiles = await readdir(Paths.agentCommonDir)
  } catch {
    // ignore if directory doesn't exist yet
  }

  for (const filename of commonFiles.filter((f) => f.endsWith('.md')).sort()) {
    const content = await readFileSafe(join(Paths.agentCommonDir, filename))
    if (content) sections.push(content)
  }

  // ── Memory section: today + yesterday daily notes (if they exist) ─────────
  const recentNotes = await loadRecentNotes(memDir, 2)
  if (recentNotes) sections.push(recentNotes)

  return sections.join(SEPARATOR)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Load today's and yesterday's daily note files as a combined memory section.
 * Returns null if no recent notes exist (avoids empty section noise).
 */
async function loadRecentNotes(memDir: string, days: number): Promise<string | null> {
  const noteSections: string[] = []

  for (let i = 0; i < days; i++) {
    const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10)
    const content = await readFileSafe(join(memDir, `${date}.md`))
    if (content) noteSections.push(content)
  }

  if (noteSections.length === 0) return null

  return `# 近期记忆\n\n${noteSections.join('\n\n---\n\n')}`
}

async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    const text = await readFile(filePath, 'utf8')
    return text.trim() || null
  } catch {
    return null
  }
}
