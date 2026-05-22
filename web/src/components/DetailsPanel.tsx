import { ChevronDown, Activity, Trash2, Clock3 } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { useStore } from "@/store";
import { Avatar } from "./Avatar";
import { StatusDot } from "./StatusDot";

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
  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshScheduledTasks();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [refreshScheduledTasks]);
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
                <span>{task.cron}</span>
                <button
                  type="button"
                  title="删除定时任务"
                  onClick={() => void deleteScheduledTask(task.id)}
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
                  下次 {formatDateTime(task.nextRunAt)}
                </div>
              </button>
            </div>
          ))}
        </div>
      </Section>

    </aside>
  );
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
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
