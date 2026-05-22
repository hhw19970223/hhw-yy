import { Terminal, Bell, PenLine, Share2, User } from "lucide-react";
import { cn } from "@/lib/cn";
import type { Agent } from "@/data/types";

type AgentRole = Agent["role"] | "user";

const roleConfig: Record<
  AgentRole,
  { icon: React.ElementType; bg: string; border: string; text: string }
> = {
  manager: {
    icon: Terminal,
    bg: "bg-[#0d2a30]",
    border: "border-agent-manager/30",
    text: "text-agent-manager",
  },
  kol: {
    icon: Bell,
    bg: "bg-[#2a200d]",
    border: "border-agent-kol/30",
    text: "text-agent-kol",
  },
  seo: {
    icon: PenLine,
    bg: "bg-[#0d2a1e]",
    border: "border-agent-seo/30",
    text: "text-agent-seo",
  },
  social: {
    icon: Share2,
    bg: "bg-[#1e0d2a]",
    border: "border-agent-social/30",
    text: "text-agent-social",
  },
  user: {
    icon: User,
    bg: "bg-bg-elevated",
    border: "border-border",
    text: "text-fg-muted",
  },
};

export function Avatar({
  role = "user",
  size = "md",
  className,
  // Legacy props kept for backward compat
  label: _label,
  seed: _seed,
}: {
  role?: AgentRole;
  size?: "sm" | "md" | "lg";
  className?: string;
  label?: string;
  seed?: number;
}) {
  const config = roleConfig[role];
  const Icon = config.icon;

  const dim =
    size === "sm"
      ? "w-7 h-7"
      : size === "lg"
        ? "w-10 h-10"
        : "w-8 h-8";

  const iconSize = size === "sm" ? 12 : size === "lg" ? 20 : 16;

  return (
    <div
      className={cn(
        "rounded-md border flex items-center justify-center shrink-0",
        config.bg,
        config.border,
        config.text,
        dim,
        className
      )}
    >
      <Icon size={iconSize} />
    </div>
  );
}
