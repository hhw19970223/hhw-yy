import {
  BriefcaseBusiness,
  CircleDot,
  Megaphone,
  MessageCircle,
  Rocket,
  Target,
  Users,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";

export const GROUP_ICON_OPTIONS = [
  { value: "users", label: "成员", icon: Users },
  { value: "target", label: "目标", icon: Target },
  { value: "megaphone", label: "宣发", icon: Megaphone },
  { value: "rocket", label: "增长", icon: Rocket },
  { value: "briefcase", label: "项目", icon: BriefcaseBusiness },
  { value: "message", label: "讨论", icon: MessageCircle },
] satisfies Array<{ value: string; label: string; icon: LucideIcon }>;

function iconFor(value?: string | null): LucideIcon {
  return GROUP_ICON_OPTIONS.find((item) => item.value === value)?.icon ?? CircleDot;
}

export function GroupIcon({
  value,
  size = "md",
  className,
}: {
  value?: string | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const Icon = iconFor(value);
  const dim = size === "sm" ? "h-7 w-7" : size === "lg" ? "h-10 w-10" : "h-8 w-8";
  const iconSize = size === "sm" ? 12 : size === "lg" ? 20 : 16;
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md border border-accent/30 bg-accent-soft text-accent",
        dim,
        className,
      )}
    >
      <Icon size={iconSize} />
    </div>
  );
}
