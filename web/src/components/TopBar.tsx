import { useStore } from "@/store";
import { cn } from "@/lib/cn";

export function TopBar({
  view,
  onViewChange,
}: {
  view: "chat" | "dashboard";
  onViewChange: (view: "chat" | "dashboard") => void;
}) {
  const agents = useStore((s) => s.agents);
  const connection = useStore((s) => s.connection);
  const online = agents.filter((a) => a.status === "online").length;

  return (
    <header className="h-12 border-b border-border bg-bg-deep flex items-center px-5 gap-4 shrink-0">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-sm tracking-tight">
          <span className="text-accent">SL</span>
          <span className="text-fg"> 控制台</span>
        </span>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-accent-soft text-accent border border-accent/20">
          v0.1 · dev
        </span>
      </div>

      <nav className="flex items-center gap-1 rounded-md border border-border bg-bg px-1 py-1">
        <TopTab
          label="任务会话"
          active={view === "chat"}
          onClick={() => onViewChange("chat")}
        />
        <TopTab
          label="总看板"
          active={view === "dashboard"}
          onClick={() => onViewChange("dashboard")}
        />
      </nav>

      <div className="flex-1" />

      <div className="flex items-center gap-1.5 text-[11px] font-mono text-fg-muted">
        <span
          className={
            connection === "open"
              ? "w-1.5 h-1.5 rounded-full bg-success shadow-glow-success"
              : connection === "connecting" || connection === "reconnecting"
                ? "w-1.5 h-1.5 rounded-full bg-warning animate-pulse-soft"
                : "w-1.5 h-1.5 rounded-full bg-fg-subtle"
          }
        />
        <span>
          {online}/{agents.length} online
        </span>
      </div>
    </header>
  );
}

function TopTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-7 rounded px-3 text-[11px] font-medium transition",
        active
          ? "bg-accent-soft text-accent"
          : "text-fg-muted hover:bg-bg-hover hover:text-fg",
      )}
    >
      {label}
    </button>
  );
}
