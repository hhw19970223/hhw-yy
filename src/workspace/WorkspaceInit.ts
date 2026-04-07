import { mkdir, writeFile, access } from 'fs/promises'
import { join } from 'path'
import { Paths } from '../config/paths.js'

const COMMON_README = `# 公共工作空间 (workspace/common/)

所有机器人的协作文件放在这里。

## 用途

- 跨机器人共享的资料、文档、任务列表
- 协作产出的中间文件
- 任何需要多个机器人共同访问的内容

## 约定

- 文件以功能命名（如 \`tasks.md\`、\`requirements.md\`、\`handoff.md\`）
- 私有文件放在 \`workspace/{botId}/\` 目录下，不要放这里
- 协作完成后整理归档，保持 common/ 目录干净

## 结构示例

\`\`\`
workspace/
├── common/
│   ├── README.md          # 本文件
│   ├── project/           # 项目信息（由产品经理维护）
│   ├── tasks.md           # 当前任务列表
│   └── handoff.md         # 机器人间交接记录
├── 产品经理/              # 产品经理的私有工作区
├── 服务端-agent/          # 服务端 agent 的私有工作区
└── ...
\`\`\`
`

const PROJECT_README = `# 项目信息

> 由**产品经理**负责维护。请在此填写项目的基础信息，团队所有成员将读取此目录了解项目环境。
> 每次接手新项目时，产品经理应首先更新此文件，并根据各角色职责分配具体信息。

---

## 项目概况

- 项目名称：
- 项目目标：
- 当前阶段：（规划 / 开发 / 测试 / 上线 / 迭代）
- 主要飞书群组 ID：

---

## 代码与部署

- 代码仓库地址：
- 主分支策略：（如 main + feature branches）
- 开发环境地址：
- 测试环境地址：
- 生产环境地址：
- 部署方式：（如 Docker / PM2 / K8s）
- CI/CD 说明：

---

## 技术栈

> 架构师负责补充和维护此节。

- 后端语言/框架：
- 数据库：
- 缓存：
- 消息队列：（如有）
- 前端框架：
- 前端语言：TypeScript / JavaScript
- 样式方案：
- 组件库：
- 状态管理：
- 构建工具：

---

## AI / Agent 相关

> 服务端-agent 负责补充和维护此节。

- Claude API 地址（baseUrl）：
- 模型选择策略：
- 成本监控方式：
- 向量数据库：（如有）
- 流量控制和限速策略：

---

## 设计规范

> 设计师负责补充和维护此节。

- Figma 项目链接：
- 设计评审流程：
- 主色调：
- 辅助色：
- 字体规范：
- 基础间距单位：
- 组件库版本：
- 与前端交接方式：

---

## 数据与运营

> 运营负责补充和维护此节。

- 数据分析平台：（如 Mixpanel / 神策 / 自研）
- 核心指标看板地址：
- App 推送渠道：
- 公告/站内信方式：
- 社群管理：
- 需求多维表格 app_token：

---

## 备注

（其他需要团队共知的信息）
`

/**
 * Initialize the full workspace structure for a bot.
 *
 * Creates (idempotent — safe to call on every startup):
 *   workspace/{botId}/                   — bot's private workspace
 *   workspace/common/                    — shared workspace for all bots
 *   workspace/common/README.md           — written once if missing
 *   workspace/common/project/README.md   — written once if missing (maintained by 产品经理)
 *
 * Agent personality files (agents/{botId}/) are handled by loadAgentPrompt().
 */
export async function initWorkspace(botId: string): Promise<void> {
  await Promise.all([
    mkdir(Paths.workspaceBot(botId), { recursive: true }),
    initCommonWorkspace(),
  ])
}

async function initCommonWorkspace(): Promise<void> {
  const projectDir = join(Paths.workspaceCommon, 'project')
  await Promise.all([
    mkdir(Paths.workspaceCommon, { recursive: true }),
    mkdir(projectDir, { recursive: true }),
  ])

  await Promise.all([
    writeIfMissing(join(Paths.workspaceCommon, 'README.md'), COMMON_README),
    writeIfMissing(join(projectDir, 'README.md'), PROJECT_README),
  ])
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  try {
    await access(path)
  } catch {
    await writeFile(path, content, 'utf8')
  }
}
