import { cn } from "@/lib/cn";
import type { AgentStatus } from "@/data/types";

const statusConfig: Record<AgentStatus, { color: string; glow: string; animate?: string }> = {
  online: {
    color: "bg-success",
    glow: "shadow-glow-success",
  },
  busy: {
    color: "bg-warning",
    glow: "shadow-glow-warning",
    animate: "animate-pulse-soft",
  },
  offline: {
    color: "bg-fg-subtle",
    glow: "",
  },
  restarting: {
    color: "bg-danger",
    glow: "shadow-glow-danger",
    animate: "animate-pulse-soft",
  },
};

export function StatusDot({
  status,
  size = "sm",
  className,
}: {
  status: AgentStatus;
  size?: "sm" | "md";
  className?: string;
}) {
  const config = statusConfig[status];
  return (
    <span
      className={cn(
        "inline-block rounded-full ring-2 ring-bg-deep",
        size === "sm" ? "w-2 h-2" : "w-2.5 h-2.5",
        config.color,
        config.glow,
        config.animate,
        className
      )}
      aria-label={status}
    />
  );
}
