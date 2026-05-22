import { ChevronDown, Activity, Trash2, Clock3 } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { useStore } from "@/store";
import { Avatar } from "./Avatar";
import { StatusDot } from "./StatusDot";
import type { ScheduledTaskItem } from "@/data/types";

export function DetailsPanel({
  onSelectConversation,
}: {
  onSelectConversation: (id: string) => void;
}) {
  const agents = useStore((s) => s.agents);
  const connection = useStore((s) => s.connection);
  const scheduledTasks = useStore((s) => s.scheduledTasks);
  const deleteScheduledTask = useStore((s) => s.deleteScheduledTask);
  const refreshScheduledTasks = useStore((s) => s.refreshScheduledTasks);
  const [deleteTarget, setDeleteTarget] = useState<ScheduledTaskItem | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshScheduledTasks();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [refreshScheduledTasks]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <aside className="w-[300px] border-l border-border bg-bg-deep flex flex-col shrink-0 overflow-y-auto">
      <Section icon={Activity} title="Agent 状态">
        <div className="space-y-1">
          {agents.length === 0 && (
            <div className="text-[11px] font-mono text-fg-subtle px-2 py-3">
              {connection === "open" ? "暂无 Agent" : `连接 ${connection}…`}
            </div>
          )}
          {agents.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-2.5 p-2 rounded-md hover:bg-bg-elevated transition"
            >
              <div className="relative">
                <Avatar role={a.role} size="sm" />
                <StatusDot
                  status={a.status}
                  className="absolute -bottom-0.5 -right-0.5"
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium">{a.name}</div>
                <div className="text-[10px] font-mono text-fg-muted truncate">
                  {a.description}
                </div>
              </div>
              <div className="text-[9px] font-mono text-fg-subtle">
                {a.pid}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section icon={Clock3} title="定时任务">
        <div className="space-y-2">
          {scheduledTasks.length === 0 && (
            <div className="text-[11px] font-mono text-fg-subtle px-2 py-3">
              暂无定时任务
            </div>
          )}
          {scheduledTasks.map((task) => (
            <div
              key={task.id}
              className="rounded-[10px] border border-border bg-bg/30 p-3 transition hover:bg-bg-elevated"
            >
              <div className="mb-1 flex items-center gap-2 text-[11px] font-mono text-fg-subtle">
                <span>{describeCron(task.cron)}</span>
                <button
                  type="button"
                  title="删除定时任务"
                  onClick={() => setDeleteTarget(task)}
                  className="ml-auto rounded p-0.5 text-fg-subtle transition hover:bg-bg-hover hover:text-danger"
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <button
                type="button"
                onClick={() => onSelectConversation(task.chatId)}
                className="block w-full text-left"
              >
                <div className="truncate text-xs font-medium text-fg">{task.title}</div>
                <div className="mt-1 truncate text-[10px] font-mono text-fg-muted">
                  距下次 {formatDistanceTo(task.nextRunAt, now)} · {formatDateTime(task.nextRunAt)}
                </div>
              </button>
            </div>
          ))}
        </div>
      </Section>

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4">
          <div className="w-full max-w-[360px] rounded-[12px] border border-border bg-bg-elevated p-4 shadow-2xl">
            <div className="text-sm font-semibold text-fg">删除定时任务？</div>
            <div className="mt-2 text-xs leading-relaxed text-fg-muted">
              删除后不会再触发「{deleteTarget.title}」，这个操作不能撤销。
            </div>
            <div className="mt-3 rounded-[10px] border border-border bg-bg/70 px-3 py-2 text-[11px] font-mono text-fg-subtle">
              {describeCron(deleteTarget.cron)} · 距下次 {formatDistanceTo(deleteTarget.nextRunAt, now)}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="rounded-[9px] border border-border bg-bg px-3 py-2 text-xs font-medium text-fg-muted transition hover:bg-bg-hover hover:text-fg"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  const id = deleteTarget.id;
                  setDeleteTarget(null);
                  void deleteScheduledTask(id);
                }}
                className="rounded-[9px] border border-danger/35 bg-danger/10 px-3 py-2 text-xs font-medium text-danger transition hover:bg-danger/15"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatDistanceTo(iso: string, nowMs: number): string {
  const diffSeconds = Math.max(0, Math.floor((new Date(iso).getTime() - nowMs) / 1_000));
  if (diffSeconds < 60) return `${diffSeconds} 秒`;
  const minutes = Math.floor(diffSeconds / 60);
  const seconds = diffSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes > 0 ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days} 天 ${restHours} 小时` : `${days} 天`;
}

function describeCron(cron: string): string {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = cron.trim().split(/\s+/);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return cron;
  if (dayOfMonth !== "*" || month !== "*" || dayOfWeek !== "*") return cron;

  if (minute.startsWith("*/") && hour === "*") {
    const interval = Number(minute.slice(2));
    return Number.isInteger(interval) ? `每 ${interval} 分钟` : cron;
  }
  if (minute === "*" && hour === "*") return "每分钟";
  if (minute === "0" && hour === "*") return "每小时";
  if (minute === "0" && hour.startsWith("*/")) {
    const interval = Number(hour.slice(2));
    return Number.isInteger(interval) ? `每 ${interval} 小时` : cron;
  }
  if (/^\d{1,2}$/.test(minute) && /^\d{1,2}$/.test(hour)) {
    return `每天 ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  }
  return cron;
}

function Section({
  icon: Icon,
  title,
  defaultOpen = true,
  children,
}: {
  icon: React.ElementType;
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-border">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-3 hover:bg-bg-elevated transition"
      >
        <div className="flex items-center gap-1.5">
          <span className="w-[3px] h-2.5 rounded-sm bg-accent shadow-glow-accent-sm" />
          <Icon size={13} className="text-fg-muted" />
        </div>
        <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.06em] text-fg-subtle flex-1 text-left">
          {title}
        </span>
        <ChevronDown
          size={13}
          className={cn(
            "text-fg-subtle transition-transform",
            !open && "-rotate-90"
          )}
        />
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}
