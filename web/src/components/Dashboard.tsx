import {
  Activity,
  BarChart3,
  CalendarClock,
  CheckCircle2,
  Clock3,
  FileText,
  MessageSquare,
  Table2,
} from "lucide-react";
import { useEffect } from "react";
import { cn } from "@/lib/cn";
import { useStore } from "@/store";
import type { Agent, Conversation, Message, ScheduledTaskItem } from "@/data/types";

export function Dashboard({
  onOpenConversation,
}: {
  onOpenConversation: (id: string) => void;
}) {
  const conversations = useStore((s) => s.conversations);
  const agents = useStore((s) => s.agents);
  const messagesByConversation = useStore((s) => s.messagesByConversation);
  const typingByConversation = useStore((s) => s.typingByConversation);
  const scheduledTasks = useStore((s) => s.scheduledTasks);
  const toolLogs = useStore((s) => s.toolLogs);
  const ensureMessages = useStore((s) => s.ensureMessages);

  useEffect(() => {
    conversations.forEach((conversation) => {
      void ensureMessages(conversation.id);
    });
  }, [conversations, ensureMessages]);

  const rows = conversations.map((conversation) =>
    buildOutputRow(
      conversation,
      agents,
      messagesByConversation[conversation.id] ?? [],
      typingByConversation[conversation.id] ?? [],
      scheduledTasks,
    ),
  );
  const activeRows = rows.filter((row) => row.running);
  const completedRows = rows.filter((row) => row.outputCount > 0 && !row.running);
  const scheduledRows = rows.filter((row) => row.nextRunAt);
  const totalOutputs = rows.reduce((sum, row) => sum + row.outputCount, 0);
  const maxAgentOutputs = Math.max(1, ...agents.map((agent) => countAgentOutputs(agent, rows)));

  return (
    <main className="flex-1 min-h-0 overflow-y-auto bg-bg">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-5 px-6 py-5">
        <section className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-[11px] font-mono text-accent">OVERVIEW</div>
            <h1 className="mt-1 text-xl font-semibold tracking-tight">总看板</h1>
            <p className="mt-1 text-xs text-fg-muted">
              汇总所有任务的会话产出、执行状态、定时任务和工具调用结果。
            </p>
          </div>
          <div className="rounded-md border border-border bg-bg-elevated px-3 py-2 text-[11px] font-mono text-fg-muted">
            最近更新 {formatDateTime(latestUpdatedAt(conversations))}
          </div>
        </section>

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <MetricCard icon={MessageSquare} label="任务总数" value={conversations.length} />
          <MetricCard icon={FileText} label="产出消息" value={totalOutputs} />
          <MetricCard icon={Activity} label="执行中" value={activeRows.length} tone="accent" />
          <MetricCard icon={CalendarClock} label="定时任务" value={scheduledRows.length} />
          <MetricCard icon={CheckCircle2} label="工具成功" value={toolLogs.filter((log) => log.status === "ok").length} tone="success" />
        </section>

        <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="rounded-md border border-border bg-bg-deep">
            <SectionTitle icon={BarChart3} title="Agent 产出分布" />
            <div className="space-y-3 px-4 pb-4">
              {agents.map((agent) => {
                const count = countAgentOutputs(agent, rows);
                return (
                  <div key={agent.id} className="grid grid-cols-[88px_minmax(0,1fr)_34px] items-center gap-3">
                    <div className="truncate text-xs text-fg-muted">{agent.name}</div>
                    <div className="h-2 overflow-hidden rounded-full bg-bg-elevated">
                      <div
                        className={cn(
                          "h-full rounded-full",
                          agent.status === "online" ? "bg-accent" : "bg-fg-subtle",
                        )}
                        style={{ width: `${Math.max(4, (count / maxAgentOutputs) * 100)}%` }}
                      />
                    </div>
                    <div className="text-right text-[11px] font-mono text-fg-subtle">{count}</div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-md border border-border bg-bg-deep">
            <SectionTitle icon={Clock3} title="待关注" />
            <div className="space-y-2 px-4 pb-4">
              <AttentionItem label="执行中任务" value={`${activeRows.length} 个`} tone={activeRows.length ? "accent" : "muted"} />
              <AttentionItem label="已有产出任务" value={`${completedRows.length} 个`} />
              <AttentionItem label="下次定时任务" value={nextScheduledLabel(scheduledTasks)} />
              <AttentionItem label="工具异常" value={`${toolLogs.filter((log) => log.status === "error").length} 次`} tone="danger" />
            </div>
          </div>
        </section>

        <section className="rounded-md border border-border bg-bg-deep">
          <SectionTitle icon={Table2} title="任务产出表" />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] border-collapse text-left text-xs">
              <thead className="border-y border-border bg-bg">
                <tr className="text-[10px] uppercase tracking-[0.08em] text-fg-subtle">
                  <th className="px-4 py-2 font-mono">任务</th>
                  <th className="px-4 py-2 font-mono">类型</th>
                  <th className="px-4 py-2 font-mono">成员</th>
                  <th className="px-4 py-2 font-mono">产出摘要</th>
                  <th className="px-4 py-2 font-mono">产出数</th>
                  <th className="px-4 py-2 font-mono">状态</th>
                  <th className="px-4 py-2 font-mono">更新时间</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-fg-subtle">
                      暂无任务产出
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr
                      key={row.id}
                      onClick={() => onOpenConversation(row.id)}
                      className="cursor-pointer border-b border-border/70 transition hover:bg-bg-elevated"
                    >
                      <td className="max-w-[210px] px-4 py-3">
                        <div className="truncate font-medium text-fg">{row.title}</div>
                        <div className="mt-0.5 truncate font-mono text-[10px] text-fg-subtle">{row.id}</div>
                      </td>
                      <td className="px-4 py-3 text-fg-muted">{row.kind === "group" ? "群聊任务" : "私聊任务"}</td>
                      <td className="max-w-[180px] px-4 py-3">
                        <div className="truncate text-fg-muted">{row.members}</div>
                      </td>
                      <td className="max-w-[360px] px-4 py-3">
                        <div className="line-clamp-2 leading-relaxed text-fg-muted">{row.summary}</div>
                      </td>
                      <td className="px-4 py-3 font-mono text-fg">{row.outputCount}</td>
                      <td className="px-4 py-3">
                        <StatusBadge running={row.running} scheduled={Boolean(row.nextRunAt)} />
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px] text-fg-subtle">{formatDateTime(row.updatedAt)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}

interface OutputRow {
  id: string;
  title: string;
  kind: Conversation["kind"];
  members: string;
  outputAgents: string[];
  outputCount: number;
  summary: string;
  running: boolean;
  nextRunAt: string | null;
  updatedAt: string;
}

function buildOutputRow(
  conversation: Conversation,
  agents: Agent[],
  messages: Message[],
  typingBotIds: string[],
  scheduledTasks: ScheduledTaskItem[],
): OutputRow {
  const memberNames = conversation.members
    .map((id) => agents.find((agent) => agent.id === id)?.name)
    .filter((name): name is string => Boolean(name));
  const agentMessages = messages.filter((message) => message.kind === "text" && message.role === "agent");
  const latestAgentText = [...agentMessages].reverse().find((message) => message.kind === "text")?.content;
  const outputAgents = Array.from(new Set(agentMessages.map((message) => message.authorId)));
  const nextRunAt = scheduledTasks.find((task) => task.chatId === conversation.id && task.enabled)?.nextRunAt ?? null;

  return {
    id: conversation.id,
    title: conversation.title,
    kind: conversation.kind,
    members: memberNames.length ? memberNames.join(" · ") : "未指定",
    outputAgents,
    outputCount: agentMessages.length,
    summary: compactText(latestAgentText || conversation.lastSnippet || "暂无产出"),
    running: typingBotIds.length > 0 || messages.some((message) => message.kind === "text" && Boolean(message.streaming)),
    nextRunAt,
    updatedAt: conversation.lastMessageAt,
  };
}

function MetricCard({
  icon: Icon,
  label,
  value,
  tone = "muted",
}: {
  icon: React.ElementType;
  label: string;
  value: number;
  tone?: "muted" | "accent" | "success";
}) {
  return (
    <div className="rounded-md border border-border bg-bg-deep p-4">
      <div className="mb-3 flex items-center justify-between">
        <Icon
          size={16}
          className={cn(
            tone === "accent" && "text-accent",
            tone === "success" && "text-success",
            tone === "muted" && "text-fg-muted",
          )}
        />
        <span className="text-[10px] font-mono text-fg-subtle">{label}</span>
      </div>
      <div className="font-mono text-2xl font-semibold text-fg">{value}</div>
    </div>
  );
}

function SectionTitle({
  icon: Icon,
  title,
}: {
  icon: React.ElementType;
  title: string;
}) {
  return (
    <div className="flex items-center gap-2 px-4 py-3">
      <span className="h-2.5 w-[3px] rounded-sm bg-accent shadow-glow-accent-sm" />
      <Icon size={14} className="text-fg-muted" />
      <span className="text-[11px] font-mono font-semibold uppercase tracking-[0.06em] text-fg-subtle">
        {title}
      </span>
    </div>
  );
}

function AttentionItem({
  label,
  value,
  tone = "muted",
}: {
  label: string;
  value: string;
  tone?: "muted" | "accent" | "danger";
}) {
  return (
    <div className="flex items-center justify-between rounded-md border border-border bg-bg px-3 py-2">
      <span className="text-xs text-fg-muted">{label}</span>
      <span
        className={cn(
          "font-mono text-[11px]",
          tone === "accent" && "text-accent",
          tone === "danger" && "text-danger",
          tone === "muted" && "text-fg-subtle",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function StatusBadge({
  running,
  scheduled,
}: {
  running: boolean;
  scheduled: boolean;
}) {
  const label = running ? "执行中" : scheduled ? "定时" : "已同步";
  return (
    <span
      className={cn(
        "inline-flex rounded px-2 py-1 font-mono text-[10px]",
        running && "bg-accent/15 text-accent",
        !running && scheduled && "bg-warning/15 text-warning",
        !running && !scheduled && "bg-success/10 text-success",
      )}
    >
      {label}
    </span>
  );
}

function countAgentOutputs(agent: Agent, rows: OutputRow[]) {
  return rows.reduce((sum, row) => sum + row.outputAgents.filter((id) => id === agent.id).length, 0);
}

function compactText(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 180);
}

function latestUpdatedAt(conversations: Conversation[]) {
  return conversations
    .map((conversation) => conversation.lastMessageAt)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? new Date().toISOString();
}

function nextScheduledLabel(tasks: ScheduledTaskItem[]) {
  const next = tasks
    .filter((task) => task.enabled)
    .sort((a, b) => new Date(a.nextRunAt).getTime() - new Date(b.nextRunAt).getTime())[0];
  return next ? formatDateTime(next.nextRunAt) : "暂无";
}

function formatDateTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "暂无";
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
