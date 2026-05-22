import { Archive, Check, MoreHorizontal, Palette, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState, type MouseEvent } from "react";
import { cn } from "@/lib/cn";
import { Avatar } from "./Avatar";
import { GroupIcon, GROUP_ICON_OPTIONS } from "./GroupIcon";
import { StatusDot } from "./StatusDot";
import { useStore } from "@/store";
import type { Agent, Conversation, Message } from "@/data/types";

function formatTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor(
    (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24)
  );
  if (diffDays >= 1) return "昨天";
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}

export function Sidebar({
  activeId,
  tab,
  onTabChange,
  onSelect,
}: {
  activeId: string;
  tab: "private" | "group";
  onTabChange: (tab: "private" | "group") => void;
  onSelect: (id: string) => void;
}) {
  const conversations = useStore((s) => s.conversations);
  const agents = useStore((s) => s.agents);
  const typingByConversation = useStore((s) => s.typingByConversation);
  const messagesByConversation = useStore((s) => s.messagesByConversation);
  const createGroupConversation = useStore((s) => s.createGroupConversation);
  const createPrivateSession = useStore((s) => s.createPrivateSession);
  const renameTask = useStore((s) => s.renameTask);
  const updateTaskIcon = useStore((s) => s.updateTaskIcon);
  const archiveTask = useStore((s) => s.archiveTask);
  const deleteTask = useStore((s) => s.deleteTask);
  const [draft, setDraft] = useState<"private" | "group" | null>(null);
  const [groupTitle, setGroupTitle] = useState("运营群聊");
  const [groupIcon, setGroupIcon] = useState("users");
  const [selectedBotIds, setSelectedBotIds] = useState<string[]>([]);
  const [privateBotId, setPrivateBotId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const privates = conversations.filter((c) => c.kind === "private");
  const groups = conversations.filter((c) => c.kind === "group");

  useEffect(() => {
    if (draft && draft !== tab) setDraft(null);
  }, [draft, tab]);

  const isRunning = (conversationId: string) => {
    const typing = (typingByConversation[conversationId] ?? []).length > 0;
    const messages = messagesByConversation[conversationId] ?? [];
    return typing || messages.some(isStreamingMessage);
  };

  const openPrivateDraft = () => {
    setPrivateBotId(agents[0]?.id ?? "");
    setCreateError("");
    onTabChange("private");
    setDraft((value) => (value === "private" ? null : "private"));
  };

  const openGroupDraft = () => {
    setSelectedBotIds(agents.map((a) => a.id));
    setGroupIcon("users");
    setCreateError("");
    onTabChange("group");
    setDraft((value) => (value === "group" ? null : "group"));
  };

  const submitPrivate = async () => {
    if (!privateBotId || creating) return;
    setCreateError("");
    setCreating(true);
    try {
      const id = await createPrivateSession(privateBotId);
      setDraft(null);
      onSelect(id);
    } catch (err) {
      setCreateError(String(err));
    } finally {
      setCreating(false);
    }
  };

  const submitGroup = async () => {
    if (creating) return;
    const selectedAgents = selectedBotIds.length > 0
      ? selectedBotIds.map((id) => agents.find((agent) => agent.id === id)).filter((agent): agent is Agent => Boolean(agent))
      : agents;
    const manager = selectedAgents.find((agent) =>
      agent.role === "manager" ||
      agent.name.includes("产品经理") ||
      agent.id.includes("产品经理"),
    );
    const botIds = manager
      ? [manager.id, ...selectedAgents.filter((agent) => agent.id !== manager.id).map((agent) => agent.id)]
      : selectedAgents.map((agent) => agent.id);
    if (botIds.length === 0) return;
    setCreateError("");
    setCreating(true);
    try {
      const id = await createGroupConversation(groupTitle.trim() || "运营群聊", botIds, groupIcon);
      setDraft(null);
      onSelect(id);
    } catch (err) {
      setCreateError(String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <aside className="w-[272px] border-r border-border bg-bg-deep flex flex-col shrink-0">
      <div className="p-3 border-b border-border">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_34px] gap-1.5">
          <TabButton
            label="私聊任务"
            count={privates.length}
            active={tab === "private"}
            onClick={() => {
              onTabChange("private");
              if (draft === "group") setDraft(null);
            }}
          />
          <TabButton
            label="群聊任务"
            count={groups.length}
            active={tab === "group"}
            onClick={() => {
              onTabChange("group");
              if (draft === "private") setDraft(null);
            }}
          />
          <IconButton
            label={tab === "private" ? "新建私聊任务" : "新建群聊任务"}
            onClick={tab === "private" ? openPrivateDraft : openGroupDraft}
            className="h-9 w-[34px] rounded-md bg-bg-elevated border border-border hover:border-accent/50"
          >
            <Plus size={15} />
          </IconButton>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto py-1">
        {tab === "private" && draft === "private" && (
          <PrivateSessionDraft
            agents={agents}
            selectedBotId={privateBotId}
            onSelect={setPrivateBotId}
            onSubmit={submitPrivate}
            creating={creating}
            error={createError}
          />
        )}
        {tab === "private" && privates.length === 0 && draft !== "private" && (
          <EmptySectionText text="点击 + 新建 Agent 私聊任务" />
        )}
        {tab === "private" && privates.map((c) => {
          const agent = agents.find((a) =>
            c.members.find((m) => m === a.id)
          );
          return (
            <ConversationItem
              key={c.id}
              conv={c}
              active={c.id === activeId}
              onClick={() => onSelect(c.id)}
              onRename={(title) => renameTask(c.id, title)}
              onArchive={() => archiveTask(c.id)}
              onDelete={() => deleteTask(c.id)}
              agentRole={agent?.role}
              statusDot={agent?.status}
              running={isRunning(c.id)}
            />
          );
        })}

        {tab === "group" && draft === "group" && (
          <GroupDraft
            agents={agents}
            title={groupTitle}
            selectedBotIds={selectedBotIds}
            icon={groupIcon}
            onTitleChange={setGroupTitle}
            onIconChange={setGroupIcon}
            onToggle={(botId) =>
              setSelectedBotIds((ids) =>
                ids.includes(botId)
                  ? ids.filter((id) => id !== botId)
                  : [...ids, botId],
              )
            }
            onSubmit={submitGroup}
            creating={creating}
            error={createError}
          />
        )}
        {tab === "group" && groups.length === 0 && draft !== "group" && (
          <EmptySectionText text="点击 + 新建群聊任务" />
        )}
        {tab === "group" && groups.map((c) => (
          <ConversationItem
            key={c.id}
            conv={c}
            active={c.id === activeId}
            onClick={() => onSelect(c.id)}
            onRename={(title) => renameTask(c.id, title)}
            onUpdateIcon={(icon) => updateTaskIcon(c.id, icon)}
            onArchive={() => archiveTask(c.id)}
            onDelete={() => deleteTask(c.id)}
            running={isRunning(c.id)}
          />
        ))}
      </nav>

      <div className="p-3 border-t border-border flex items-center gap-2.5">
        <Avatar role="user" size="sm" />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium">本地控制台</div>
          <div className="text-[10px] font-mono text-fg-muted">Web IM</div>
        </div>
      </div>
    </aside>
  );
}

function EmptySectionText({ text }: { text: string }) {
  return (
    <div className="mx-3 mb-2 px-2 py-2 text-[11px] font-mono text-fg-subtle">
      {text}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
  className,
  disabled,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "inline-flex items-center justify-center p-0.5 leading-none text-fg-subtle outline-none transition hover:text-fg focus-visible:border-accent/50 focus-visible:shadow-[0_0_0_2px_rgba(34,211,238,0.12)] disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
    >
      {children}
    </button>
  );
}

function TabButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-9 min-w-0 rounded-md border px-2 text-[11px] font-medium outline-none transition flex items-center justify-center gap-1.5 focus-visible:border-accent/50 focus-visible:shadow-[0_0_0_2px_rgba(34,211,238,0.12)]",
        active
          ? "border-accent/40 bg-accent-soft text-accent"
          : "border-border bg-bg-elevated text-fg-muted hover:text-fg",
      )}
    >
      <span className="truncate">{label}</span>
      <span className="font-mono text-[10px] opacity-70">{count}</span>
    </button>
  );
}

function PrivateSessionDraft({
  agents,
  selectedBotId,
  onSelect,
  onSubmit,
  creating,
  error,
}: {
  agents: Agent[];
  selectedBotId: string;
  onSelect: (botId: string) => void;
  onSubmit: () => void;
  creating: boolean;
  error: string;
}) {
  return (
    <div className="mx-2 mb-2 rounded-md border border-border bg-bg-elevated p-2 space-y-2">
      <select
        value={selectedBotId}
        onChange={(event) => onSelect(event.target.value)}
        className="w-full bg-bg px-2 py-1.5 rounded text-xs border border-border focus:border-accent focus:outline-none"
      >
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={creating || !selectedBotId}
        onClick={onSubmit}
        className="w-full rounded bg-accent-soft border border-accent/20 px-2 py-1.5 text-[11px] font-mono text-accent hover:bg-accent/15 disabled:opacity-50 disabled:cursor-not-allowed transition"
      >
        {creating ? "创建中…" : "创建任务"}
      </button>
      {error && <CreateError text={error} />}
    </div>
  );
}

function GroupDraft({
  agents,
  title,
  selectedBotIds,
  icon,
  onTitleChange,
  onIconChange,
  onToggle,
  onSubmit,
  creating,
  error,
}: {
  agents: Agent[];
  title: string;
  selectedBotIds: string[];
  icon: string;
  onTitleChange: (title: string) => void;
  onIconChange: (icon: string) => void;
  onToggle: (botId: string) => void;
  onSubmit: () => void;
  creating: boolean;
  error: string;
}) {
  return (
    <div className="mx-2 mb-2 rounded-md border border-border bg-bg-elevated p-2 space-y-2">
      <input
        value={title}
        onChange={(event) => onTitleChange(event.target.value)}
        className="w-full bg-bg px-2 py-1.5 rounded text-xs border border-border focus:border-accent focus:outline-none"
      />
      <IconSelector value={icon} onChange={onIconChange} />
      <div className="space-y-1">
        {agents.map((agent) => (
          <label
            key={agent.id}
            className="flex items-center gap-2 text-xs text-fg-muted px-1 py-0.5"
          >
            <input
              type="checkbox"
              checked={selectedBotIds.includes(agent.id)}
              onChange={() => onToggle(agent.id)}
              className="accent-cyan-400"
            />
            <span className="truncate">{agent.name}</span>
          </label>
        ))}
      </div>
      <button
        type="button"
        disabled={creating}
        onClick={onSubmit}
        className="w-full rounded bg-accent-soft border border-accent/20 px-2 py-1.5 text-[11px] font-mono text-accent hover:bg-accent/15 disabled:opacity-50 disabled:cursor-not-allowed transition"
      >
        {creating ? "创建中…" : "创建群聊任务"}
      </button>
      {error && <CreateError text={error} />}
    </div>
  );
}

function IconSelector({
  value,
  onChange,
}: {
  value: string;
  onChange: (icon: string) => void;
}) {
  return (
    <div className="grid grid-cols-6 gap-1">
      {GROUP_ICON_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.label}
          aria-label={option.label}
          onClick={() => onChange(option.value)}
          className={cn(
            "flex h-8 items-center justify-center rounded-md border transition",
            value === option.value
              ? "border-accent/50 bg-accent-soft"
              : "border-border bg-bg hover:border-accent/30 hover:bg-bg-hover",
          )}
        >
          <GroupIcon value={option.value} size="sm" />
        </button>
      ))}
    </div>
  );
}

function CreateError({ text }: { text: string }) {
  return (
    <div className="rounded border border-danger/30 bg-danger/10 px-2 py-1.5 text-[11px] text-danger">
      创建失败，请确认后端已连接后重试
      <span className="mt-1 block break-words font-mono text-[10px] opacity-80">{text}</span>
    </div>
  );
}

function isStreamingMessage(message: Message): boolean {
  return message.kind === "text" && (Boolean(message.streaming) || message.status === "pending");
}

function ConversationItem({
  conv,
  active,
  onClick,
  onRename,
  onUpdateIcon,
  onArchive,
  onDelete,
  agentRole,
  statusDot,
  running,
}: {
  conv: Conversation;
  active: boolean;
  onClick: () => void;
  onRename: (title: string) => Promise<void>;
  onUpdateIcon?: (icon: string) => Promise<void>;
  onArchive: () => Promise<void>;
  onDelete: () => Promise<void>;
  agentRole?: import("@/data/types").Agent["role"];
  statusDot?: import("@/data/types").AgentStatus;
  running: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(conv.title);
  const [saving, setSaving] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [iconOpen, setIconOpen] = useState(false);

  const cancel = () => {
    setTitle(conv.title);
    setEditing(false);
  };

  const save = async () => {
    const next = title.trim();
    if (!next || next === conv.title) {
      cancel();
      return;
    }
    setSaving(true);
    try {
      await onRename(next);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const archive = async () => {
    if (mutating) return;
    setMutating(true);
    try {
      await onArchive();
    } finally {
      setMutating(false);
    }
  };

  const remove = async () => {
    if (mutating) return;
    if (!window.confirm(`删除任务「${conv.title}」？此操作会删除任务消息。`)) return;
    setMutating(true);
    try {
      await onDelete();
    } finally {
      setMutating(false);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        if (!editing) onClick();
      }}
      onKeyDown={(event) => {
        if (editing) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
      className={cn(
        "group flex cursor-pointer items-center gap-2.5 px-2.5 py-2 mx-2 rounded-[10px] transition border mb-0.5 focus:outline-none focus:ring-1 focus:ring-accent/50",
        active
          ? "bg-accent-soft border-accent/20 shadow-[inset_0_0_20px_rgba(34,211,238,0.05)]"
          : "hover:bg-bg-elevated border-transparent",
        running && "border-accent/40 bg-accent-soft/60 shadow-[inset_0_0_20px_rgba(34,211,238,0.06)]"
      )}
    >
      <button type="button" onClick={onClick} className="relative shrink-0">
        {conv.kind === "group" ? (
          <GroupIcon value={conv.icon} size="md" />
        ) : (
          <Avatar
            role={agentRole ?? "user"}
            size="md"
          />
        )}
        {statusDot && (
          <StatusDot
            status={statusDot}
            className="absolute -bottom-0.5 -right-0.5"
          />
        )}
        {running && (
          <span className="absolute -top-0.5 -right-0.5 flex h-3 w-3">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-50" />
            <span className="relative inline-flex h-3 w-3 rounded-full border border-bg-deep bg-accent" />
          </span>
        )}
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          {editing ? (
            <input
              value={title}
              autoFocus
              disabled={saving}
              onChange={(event) => setTitle(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") void save();
                if (event.key === "Escape") cancel();
              }}
              className="min-w-0 flex-1 rounded border border-accent/40 bg-bg px-1.5 py-0.5 text-[13px] text-fg outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={onClick}
              className="min-w-0 flex-1 text-left text-[13px] font-medium truncate text-fg"
            >
              {conv.title}
            </button>
          )}
          <span className="text-[10px] font-mono text-fg-subtle shrink-0">
            {running ? "执行中" : formatTime(conv.lastMessageAt)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 mt-0.5">
          <button
            type="button"
            onClick={onClick}
            className={cn(
              "min-w-0 flex-1 text-left text-xs truncate",
              running ? "font-mono text-accent animate-pulse-soft" : "text-fg-muted",
            )}
          >
            {running ? "执行中…" : conv.lastSnippet}
          </button>
          {conv.unread > 0 && (
            <span className="text-[9px] font-mono font-semibold min-w-[16px] h-4 flex items-center justify-center bg-danger text-white px-1 rounded-full shrink-0">
              {conv.unread}
            </span>
          )}
        </div>
      </div>
      {editing ? (
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton label="保存任务名称" onClick={() => void save()}>
            <Check size={13} />
          </IconButton>
          <IconButton label="取消修改" onClick={cancel}>
            <X size={13} />
          </IconButton>
        </div>
      ) : (
        <div
          className="relative shrink-0 opacity-70 group-hover:opacity-100"
          onClick={(event) => event.stopPropagation()}
        >
          <IconButton
            label="任务操作"
            onClick={() => undefined}
            disabled={mutating}
            className="peer rounded hover:bg-bg-hover"
          >
            <MoreHorizontal size={15} />
          </IconButton>
          <div className="pointer-events-none absolute right-0 top-1/2 z-20 flex -translate-y-1/2 translate-x-1 gap-0.5 rounded-md border border-border bg-bg-elevated px-1 py-1 opacity-0 shadow-lg transition peer-hover:pointer-events-auto peer-hover:opacity-100 hover:pointer-events-auto hover:opacity-100">
            <IconButton
              label="归档任务"
              onClick={() => void archive()}
              disabled={mutating}
              className="rounded hover:bg-bg-hover"
            >
              <Archive size={13} />
            </IconButton>
            <IconButton
              label="删除任务"
              onClick={() => void remove()}
              disabled={mutating}
              className="rounded hover:bg-bg-hover hover:text-danger"
            >
              <Trash2 size={13} />
            </IconButton>
            <IconButton
              label="修改任务名称"
              disabled={mutating}
              onClick={() => setEditing(true)}
              className="rounded hover:bg-bg-hover"
            >
              <Pencil size={13} />
            </IconButton>
            {conv.kind === "group" && onUpdateIcon && (
              <IconButton
                label="设置群聊图标"
                disabled={mutating}
                onClick={() => setIconOpen((open) => !open)}
                className="rounded hover:bg-bg-hover"
              >
                <Palette size={13} />
              </IconButton>
            )}
          </div>
          {iconOpen && conv.kind === "group" && onUpdateIcon && (
            <div className="absolute right-0 top-8 z-30 w-36 rounded-md border border-border bg-bg-elevated p-1 shadow-lg">
              {GROUP_ICON_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={(event: MouseEvent<HTMLButtonElement>) => {
                    event.stopPropagation();
                    setIconOpen(false);
                    void onUpdateIcon(option.value);
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-fg-muted hover:bg-bg-hover hover:text-fg"
                >
                  <GroupIcon value={option.value} size="sm" />
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
