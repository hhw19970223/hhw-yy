# hhw-yy — 项目说明（供 Claude Code 使用）

## 项目是什么

多机器人飞书网关服务。将多个飞书机器人各自接入一个 Claude 大模型实例，实现在飞书私聊/群聊中与 AI 对话。同时暴露一个 MCP Server（stdio），让 Claude Code 可以通过工具调用管理所有机器人。

## 运行时进程结构

```
主进程 (src/main.ts)
├── Gateway          — 每个 Bot 一条飞书 WebSocket 长连接
├── Manager          — fork 子进程、心跳检测、崩溃重启
├── HttpServer       — GET /health  /bots  /bots/:id
└── McpServer        — stdio，供 Claude Code 调用

子进程 (src/process/worker.ts，每个 Bot 独立 fork)
├── MessageHandler   — 过滤策略 → Claude 流式对话 → 飞书回复
├── ClaudeClient     — 流式 / 非流式调用，含指数退避重试
├── ConversationStore — 每个 chatId 独立对话历史，支持 JSONL 持久化 + 自动压缩
└── MemoryStore      — Bot 的 Markdown 日记式记忆，每 30s 刷盘到 agents/{botId}/memory/
```

主进程与子进程通过 Node.js IPC 通信（`process.send` / `child.send`）。飞书收发消息全部走主进程的 Gateway，子进程只处理 Claude 调用和业务逻辑。

## 目录结构

```
src/
├── main.ts                   # 入口，启动所有子系统
├── config/
│   ├── schema.ts             # Zod 校验：RootConfig / MainAgentConfig / SubAgentConfig
│   ├── loader.ts             # 读取并校验 config.json
│   └── paths.ts              # 运行时路径（对话历史文件路径等）
├── gateway/
│   ├── Gateway.ts            # 管理所有 GatewayConnection，路由入站消息
│   └── GatewayConnection.ts  # 单个 Bot 的飞书 WebSocket 连接 + 消息收发
├── process/
│   ├── Manager.ts            # fork/重启/心跳/stopAll
│   ├── worker.ts             # 子进程入口
│   ├── BotHandle.ts          # 运行时状态快照（pid/status/restartCount…）
│   └── ipc/                  # IPC 消息类型定义 + 收发工具函数
├── feishu/
│   ├── FeishuClient.ts       # 飞书 HTTP API 封装（发消息、加反应等）
│   ├── MessageHandler.ts     # 消息过滤门控 → Claude 调用 → 回复
│   ├── IpcSender.ts          # 子进程向主进程发送 FEISHU_SEND 等 IPC 消息
│   └── reply/
│       ├── Formatter.ts      # 回复文本格式化（分块、截断）
│       └── Sender.ts         # 实际调用 FeishuClient 发送消息
├── llm/
│   └── ClaudeClient.ts       # Anthropic SDK 封装，流式 + 非流式 + 摘要，含重试
├── session/
│   └── ConversationStore.ts  # 每 chatId 对话历史，JSONL 持久化，80% 触发自动压缩
├── memory/
│   └── MemoryStore.ts        # Bot Markdown 日记式记忆（每天一个 .md 文件）
├── mcp/
│   ├── server.ts             # MCP Server 注册所有工具
│   └── tools/                # list_bots / send_message / get_history / start/stop/get_config
│                             # + workspace_list / workspace_read / workspace_write / workspace_delete
└── server/
    └── HttpServer.ts         # 轻量 HTTP 状态接口
```

## 配置文件

`config.json`（已 gitignore，从 `config.example.json` 复制）

关键字段：
- `gateway.port` — HTTP server 端口，默认 4000
- `agents[].feishu.appId/appSecret` — 飞书应用凭证
- `agents[].claude.apiKey` — Claude API Key，可省略改用 `ANTHROPIC_API_KEY` 环境变量
- `agents[].claude.baseUrl` — API 根地址，**不含 `/v1`**（SDK 自动拼接）
- `agents[].claude.model` — 模型名，如 `claude-opus-4-6`、`claude-sonnet-4-6`
- `agents[].subAgents[]` — 同结构，每个子 Agent 是独立飞书应用

## 常用命令

```bash
npm run dev          # 直接运行 TypeScript（开发）
npm run build        # tsc 编译到 dist/
npm start            # 运行编译产物
npm run typecheck    # 类型检查，不输出文件

npm run pm2:start    # PM2 启动（生产推荐）
npm run pm2:restart
npm run pm2:log
```

## 关键设计约定

1. **IPC 消息类型** 定义在 `src/process/ipc/types.ts`，向上（子→主）和向下（主→子）分开。修改协议时两端都要同步。

2. **重试逻辑** 在 `ClaudeClient.ts`：RateLimit/Overload 最多重试 3 次，404/502/503 最多重试 5 次，指数退避。404 被视为瞬态错误（代理不稳定场景）。

3. **对话压缩** 在 `ConversationStore.compactIfNeeded`：历史达到 80% 上限时，将前半段摘要为一个 user/assistant 对，fire-and-forget 不阻塞回复。

4. **心跳机制** Manager 每 `heartbeatIntervalMs` 向各子进程发 PING，超过 `heartbeatTimeoutMs` 未收到 PONG 则 SIGKILL 后重启。

5. **消息过滤顺序**（MessageHandler.handle）：消息类型 → 策略门控（私聊/群聊/allowlist/denylist/@mention）→ 自消息过滤 → typing 反应 → Claude 调用。

6. **飞书消息收发分离**：所有飞书 API 调用只在主进程（Gateway/GatewayConnection）执行。子进程通过 IPC 发 `FEISHU_SEND` / `FEISHU_REACTION_*` 消息委托主进程发送。

## 运行时产物（均已 gitignore）

| 路径 | 内容 |
|------|------|
| `error/YYYY-MM-DD.log` | 每日错误日志（JSONL）|
| `agents/{botId}/memory/YYYY-MM-DD.md` | Bot 每日 Markdown 记忆笔记 |
| `workspace/{botId}/` | Bot 私有工作目录（MCP workspace 工具操作范围）|
| `workspace/common/` | 所有 Bot 共享工作目录 |
| `~/.local/share/hhw-yy/conversations/{botId}/{chatId}.jsonl` | 对话历史持久化（`persistHistory: true` 时）|
| `dist/` | TypeScript 编译输出 |

## Agent 身份文件

每个 Bot 在 `agents/{botId}/` 下有身份定义文件（Markdown），由 `src/config/agentPrompt.ts` 在启动时加载并拼接为系统提示词：

- `IDENTITY.md` — Bot 的角色、名称、职责
- `SOUL.md` — 性格、沟通风格
- `AGENTS.md` — 多 Agent 协作说明
- `TOOLS.md` — 可用工具说明
- `memory/` — 历史记忆笔记目录
