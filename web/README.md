# SL Web 控制台(骨架版)

为 SL 多 Bot 网关提供独立的 React Web IM,作为飞书的替代/演示入口。
当前版本只包含 **UI 骨架 + Mock 数据**,用于交给 OpenDesign 重新设计。

## 技术选型
- Vite 6 + React 18 + TypeScript
- Tailwind CSS 3(深色主题,设计 token 在 `tailwind.config.js`)
- 组件库:不引入重型库(避免被覆盖),用 `lucide-react` + 自写组件,接近 shadcn 风格
- Markdown 渲染:`react-markdown` + `remark-gfm`

## 开始

```bash
cd web
npm install   # 或 pnpm install
npm run dev   # 默认 http://localhost:5173
```

## 目录

```
src/
├── App.tsx                   # 三栏 shell
├── main.tsx
├── index.css                 # tailwind 指令 + 滚动条
├── lib/cn.ts                 # 样式合并工具
├── data/
│   ├── types.ts              # Agent / Conversation / Message / Task 类型
│   └── mock.ts               # 演示用假数据
└── components/
    ├── TopBar.tsx            # 顶部栏
    ├── Sidebar.tsx           # 左侧会话列表(私聊/群聊)
    ├── ChatArea.tsx          # 中部消息区(头部 + 列表 + Composer)
    ├── MessageBubble.tsx     # 文本/工具调用/审批/任务 卡片化气泡
    ├── Composer.tsx          # 底部输入器
    ├── DetailsPanel.tsx      # 右侧 Agent 状态/任务/工具日志
    ├── Avatar.tsx
    └── StatusDot.tsx
```

## 设计交付

- 交互规格(给设计师):[../docs/web-im-interaction-spec.md](../docs/web-im-interaction-spec.md)
- 技术 PRD(给工程):[../docs/web-im-prd.md](../docs/web-im-prd.md)

## 下一步

骨架完成后,真实接入步骤(暂未实现):
1. 用 `fetch` + `WebSocket` 替换 `data/mock.ts`,接 [`../src/server/HttpServer.ts`](../src/server/HttpServer.ts) 新增的 `/web/*`。
2. Composer 发送 → POST 后端,WS 推流式 chunk 回前端追加到对应 message。
3. 审批按钮 → POST `/web/approvals/:id/decision` → 后端 IPC 给子进程。
