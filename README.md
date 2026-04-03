# hhw-yy

多机器人飞书网关服务，支持将多个飞书机器人接入 Claude，并通过 MCP Server 与 Claude Code 集成。

## 架构概览

```
┌─────────────────────────────────────────────┐
│                 主进程 (Gateway)              │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │ Feishu   │  │  HTTP    │  │   MCP     │  │
│  │ WebSocket│  │  Server  │  │  Server   │  │
│  │ (每个Bot)│  │  :4000   │  │  (stdio)  │  │
│  └────┬─────┘  └──────────┘  └───────────┘  │
│       │ IPC                                  │
│  ┌────▼──────────────────────────────────┐   │
│  │            Manager (进程管理)          │   │
│  └────┬──────────────┬───────────────────┘   │
└───────┼──────────────┼───────────────────────┘
        │ fork         │ fork
   ┌────▼────┐    ┌────▼────┐
   │ Worker  │    │ Worker  │   (每个 Bot 独立进程)
   │ (Bot A) │    │ (Bot B) │
   └─────────┘    └─────────┘
```

每个 Bot 运行在独立子进程中，崩溃后自动重启（最多 10 次）。主进程通过 IPC 转发飞书消息，子进程通过 IPC 回传消息发送指令。

## 前置要求

- Node.js >= 22
- 飞书开放平台应用（每个 Bot 需要一个独立应用）
- Claude API Key（支持官方 API 及第三方代理）

## 安装

```bash
cd hhw-yy
npm install
```

## 配置

### 1. 创建配置文件

```bash
cp config.example.json config.json
```

### 2. 编辑 config.json

| 字段 | 说明 |
|------|------|
| `gateway.port` | HTTP 状态服务端口，默认 `4000` |
| `gateway.heartbeatIntervalMs` | 心跳检测间隔（毫秒），默认 `15000` |
| `gateway.heartbeatTimeoutMs` | 心跳超时阈值（毫秒），默认 `5000` |

**Agent 配置（`agents[]`）**

每个 Agent 对应一个"主控"机器人，可以挂载多个子 Agent。主控与子 Agent 各自是独立的飞书应用。

| 字段 | 说明 |
|------|------|
| `id` | 唯一标识，建议与飞书机器人名称一致 |
| `feishu.appId` | 飞书应用的 App ID |
| `feishu.appSecret` | 飞书应用的 App Secret |
| `claude.apiKey` | Claude API Key（可用环境变量替代，见下方）|
| `claude.baseUrl` | API 地址，官方填 `https://api.anthropic.com`，代理填代理根地址（**不含 `/v1`**）|
| `claude.model` | 模型名称，如 `claude-opus-4-6`、`claude-sonnet-4-6` |
| `claude.systemPrompt` | 系统提示词 |
| `claude.maxTokens` | 单次最大输出 Token 数 |
| `claude.historyLimit` | 保留的对话轮次上限 |
| `access.dmPolicy` | 私聊策略：`open` / `allowlist` / `disabled` |
| `access.groupPolicy` | 群聊策略：`open` / `allowlist` / `disabled` |
| `access.requireMention` | 群聊是否需要 @ 机器人才响应 |
| `access.allowFrom` | 白名单（用户 ID / 群 ID），策略为 `allowlist` 时生效 |
| `behavior.replyMode` | 回复形式：`text`（普通文本）/ `card`（消息卡片）|
| `behavior.persistHistory` | 是否将对话历史持久化到磁盘 |
| `subAgents[]` | 子 Agent 列表，结构与主 Agent 相同（无 `subAgents` 嵌套）|

### 3. 使用环境变量管理 API Key（可选）

在 `config.json` 中省略 `claude.apiKey`，改用环境变量：

```bash
# .env 或 Shell 导出
export ANTHROPIC_API_KEY=sk-ant-xxxxxxxx
```

所有未配置 `apiKey` 的 Agent 将统一读取该环境变量。

### 4. 飞书应用配置

在[飞书开放平台](https://open.feishu.cn)为每个 Bot 完成以下配置：

1. 创建企业自建应用
2. 记录 **App ID** 和 **App Secret** 填入 `config.json`
3. 开启**机器人**能力
4. 在「权限管理」中开启以下权限：
   - `im:message`（读取消息）
   - `im:message:send_as_bot`（发送消息）
   - `im:message.reaction:add`（添加表情回应）
5. 在「事件订阅」中添加 `im.message.receive_v1` 事件，使用**长连接**（WebSocket）模式，无需配置 Webhook 回调地址

## 运行

### 开发模式

```bash
npm run dev
```

直接运行 TypeScript 源码，代码修改后需手动重启。

### 生产模式

```bash
npm run build   # 编译 TypeScript
npm start       # 运行编译产物
```

### PM2 管理（推荐生产使用）

```bash
npm run pm2:start    # 启动
npm run pm2:stop     # 停止
npm run pm2:restart  # 重启
npm run pm2:status   # 查看状态
npm run pm2:log      # 查看日志
```

## HTTP 状态接口

服务启动后，以下接口在 `gateway.port` 上可用：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查，返回 `{"status":"ok","uptime":...}` |
| GET | `/bots` | 所有 Bot 的状态快照列表 |
| GET | `/bots/:botId` | 指定 Bot 的状态，不存在返回 404 |

## MCP Server 集成（Claude Code）

服务启动时会在 `stdio` 上暴露一个 MCP Server，供 Claude Code 通过工具调用管理机器人。

在 Claude Code 的 MCP 配置中添加：

```json
{
  "mcpServers": {
    "hhw-yy": {
      "command": "node",
      "args": ["dist/main.js"],
      "cwd": "/path/to/hhw-yy"
    }
  }
}
```

可用工具：

| 工具 | 说明 |
|------|------|
| `list_bots` | 列出所有 Bot 及其状态 |
| `send_message` | 向指定 Bot 的会话注入消息 |
| `get_history` | 查看指定 Bot 的对话历史 |
| `start_bot` | 启动指定 Bot |
| `stop_bot` | 停止指定 Bot |
| `get_bot_config` | 查看指定 Bot 的运行配置 |

> **注意**：`npm run dev` 模式下同时启动了 MCP stdio server，若从 Claude Code 挂载为 MCP 服务，请使用 `npm start`（编译产物）而非开发模式，避免 stdio 冲突。

## 错误日志

运行时错误写入 `error/YYYY-MM-DD.log`，每行为 JSON 格式：

```json
{"ts":"2026-04-03T03:29:15.397Z","level":"error","process":"worker:Bot名","message":"...","botId":"Bot名"}
```

## 常见问题

**Q: 启动后 Bot 全部报 `Claude API key not found`**
A: `config.json` 中未填 `claude.apiKey`，且未设置 `ANTHROPIC_API_KEY` 环境变量。

**Q: 调用 Claude API 报 `404 {"detail":"Not Found"}`**
A: `claude.baseUrl` 末尾多了 `/v1`。Anthropic SDK 会自动拼接 `/v1/messages`，`baseUrl` 只需填根地址，例如 `https://api.anthropic.com`。

**Q: Ctrl+C 关闭进程后终端报错退出**
A: 开发模式下 MCP stdio server 绑定了 `process.stdin`，关闭时与 SIGINT 产生竞态。生产环境请使用 `pm2` 或 `service.sh` 管理进程生命周期。
