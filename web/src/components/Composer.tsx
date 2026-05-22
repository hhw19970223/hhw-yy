import { useEffect, useMemo, useRef, useState, type ElementType, type KeyboardEvent } from "react";
import { Paperclip, AtSign, Send, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useStore } from "@/store";
import { uploadAttachment } from "@/api/rest";
import type { Agent, AttachmentMeta, SkillDefinition, TextMessage } from "@/data/types";

interface AttachmentDraft {
  id: string;
  file: File;
  name: string;
  size: number;
  type: string;
  content?: string;
  status?: "ready" | "uploading" | "uploaded" | "error";
  error?: string;
}

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function Composer({
  placeholder,
  conversationId,
  quotedMessage,
  onClearQuote,
  mentionAgents = [],
  skillOwner,
}: {
  placeholder?: string;
  conversationId: string;
  quotedMessage?: TextMessage | null;
  onClearQuote?: () => void;
  mentionAgents?: Agent[];
  skillOwner?: SkillDefinition["owner"];
}) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [sending, setSending] = useState(false);
  const [skillOpen, setSkillOpen] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const sendMessage = useStore((s) => s.sendMessage);
  const addSkillRunForm = useStore((s) => s.addSkillRunForm);
  const skills = useStore((s) => s.skills);
  const availableSkills = useMemo(
    () => skillOwner ? skills.filter((skill) => skill.owner === skillOwner) : [],
    [skillOwner, skills],
  );
  const canMention = mentionAgents.length > 0;
  const canUseSkills = availableSkills.length > 0;
  const hasAttachmentErrors = attachments.some((file) => file.status === "error" || file.error);
  const canSend = (value.trim().length > 0 || attachments.length > 0) && !sending && !hasAttachmentErrors;
  const filteredMentions = useMemo(() => {
    const query = mentionQuery.trim().toLowerCase();
    if (!query) return mentionAgents;
    return mentionAgents.filter((agent) =>
      `${agent.name} ${agent.id}`.toLowerCase().includes(query),
    );
  }, [mentionAgents, mentionQuery]);

  useEffect(() => {
    resetComposer();
  }, [conversationId]);

  useEffect(() => {
    if (!canUseSkills) setSkillOpen(false);
  }, [canUseSkills]);

  function resetComposer() {
    setValue("");
    setAttachments([]);
    setMentionOpen(false);
    setMentionQuery("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleSend() {
    if (!canSend) return;
    setSending(true);
    try {
      const uploaded: AttachmentMeta[] = [];
      for (const attachment of attachments) {
        setAttachments((current) =>
          current.map((item) =>
            item.id === attachment.id ? { ...item, status: "uploading", error: undefined } : item,
          ),
        );
        try {
          const file = await uploadAttachmentDraft(attachment, conversationId);
          uploaded.push(file);
          setAttachments((current) =>
            current.map((item) =>
              item.id === attachment.id ? { ...item, status: "uploaded" } : item,
            ),
          );
        } catch (err) {
          setAttachments((current) =>
            current.map((item) =>
              item.id === attachment.id
                ? { ...item, status: "error", error: err instanceof Error ? err.message : "上传失败" }
                : item,
            ),
          );
          return;
        }
      }
      const body = buildMessageWithAttachments(value.trim(), uploaded);
      const text = quotedMessage
        ? formatQuotedMessage(quotedMessage, body)
        : body;
      resetComposer();
      onClearQuote?.();
      await sendMessage(conversationId, text);
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing || composingRef.current || e.keyCode === 229) {
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
      return;
    }
    if (e.key === "Escape" && mentionOpen) {
      e.preventDefault();
      setMentionOpen(false);
    }
  }

  function handleValueChange(nextValue: string, caret: number | null) {
    setValue(nextValue);
    if (!canMention || caret === null) {
      setMentionOpen(false);
      return;
    }
    const beforeCaret = nextValue.slice(0, caret);
    const match = beforeCaret.match(/(^|\s)@([^\s@]*)$/);
    if (!match) {
      setMentionOpen(false);
      setMentionQuery("");
      return;
    }
    setMentionQuery(match[2] ?? "");
    setMentionOpen(true);
  }

  function openMentionList() {
    if (!canMention) return;
    const textarea = textareaRef.current;
    const caret = textarea?.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const after = value.slice(caret);
    const needsSpace = before.length > 0 && !/\s$/.test(before);
    const next = `${before}${needsSpace ? " " : ""}@${after}`;
    const nextCaret = before.length + (needsSpace ? 2 : 1);
    setValue(next);
    setMentionQuery("");
    setMentionOpen(true);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  }

  function insertMention(agent: Agent) {
    const textarea = textareaRef.current;
    const caret = textarea?.selectionStart ?? value.length;
    const beforeCaret = value.slice(0, caret);
    const match = beforeCaret.match(/(^|\s)@([^\s@]*)$/);
    const start = match ? beforeCaret.length - (match[2]?.length ?? 0) - 1 : caret;
    const prefix = value.slice(0, start);
    const suffix = value.slice(caret);
    const inserted = `@${agent.name} `;
    const next = `${prefix}${inserted}${suffix}`;
    const nextCaret = prefix.length + inserted.length;
    setValue(next);
    setMentionOpen(false);
    setMentionQuery("");
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  }

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    const next = await Promise.all(Array.from(files).map(readAttachmentDraft));
    setAttachments((current) => [...current, ...next]);
  }

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((item) => item.id !== id));
  }

  return (
    <div className="px-3 py-3 border-t border-border shrink-0 sm:px-5">
      <div
        className={cn(
          "rounded-[10px] border bg-bg-elevated transition-all",
          focused
            ? "border-accent/60 shadow-[0_0_0_2px_rgba(34,211,238,0.1)]"
            : "border-border"
        )}
      >
        {skillOpen && (
          <SkillLauncher
            conversationId={conversationId}
            skills={availableSkills}
            sending={sending}
            onPrepare={(skill) => {
              void addSkillRunForm(conversationId, skill);
              setSkillOpen(false);
            }}
          />
        )}
        {mentionOpen && canMention && (
          <MentionPicker
            agents={filteredMentions}
            onSelect={insertMention}
          />
        )}
        {quotedMessage && (
          <QuotePreview
            message={quotedMessage}
            onClear={() => onClearQuote?.()}
          />
        )}
        {attachments.length > 0 && (
          <AttachmentTray attachments={attachments} onRemove={removeAttachment} />
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => void handleFiles(event.target.files)}
        />
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => handleValueChange(e.target.value, e.target.selectionStart)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          rows={1}
          placeholder={placeholder ?? "输入消息,使用 @ 召唤特定 Agent…"}
          className="w-full bg-transparent px-4 pt-3 pb-2 text-[13px] placeholder:text-fg-subtle resize-none focus:outline-none min-h-[36px] max-h-[120px]"
        />
        <div className="flex items-center gap-1 px-2 pb-2 pt-1 border-t border-border/50">
          <ToolButton
            icon={Paperclip}
            label="添加文件"
            onClick={() => fileInputRef.current?.click()}
          />
          {canMention && (
            <ToolButton
              icon={AtSign}
              label="@提及"
              active={mentionOpen}
              onClick={openMentionList}
            />
          )}
          {canUseSkills && (
            <ToolButton
              icon={Sparkles}
              label="技能运行器"
              active={skillOpen}
              onClick={() => setSkillOpen((open) => !open)}
            />
          )}
          <div className="flex-1" />
          <button
            disabled={!canSend}
            onClick={() => void handleSend()}
            className={cn(
              "flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-medium transition",
              canSend
                ? "bg-accent text-bg-deep hover:shadow-glow-accent"
                : "bg-bg-hover text-fg-subtle cursor-not-allowed opacity-40"
            )}
          >
            <Send size={13} /> {sending && attachments.length > 0 ? "上传中" : "发送"}
          </button>
        </div>
      </div>
      <div className="text-[10px] font-mono text-fg-subtle mt-1.5 px-1">
        Enter 发送 · Shift+Enter 换行
      </div>
    </div>
  );
}

async function uploadAttachmentDraft(file: AttachmentDraft, conversationId: string): Promise<AttachmentMeta> {
  const uploaded = await uploadAttachment(file.file, conversationId);
  return {
    ...uploaded,
    text: file.content,
  };
}

function buildMessageWithAttachments(text: string, attachments: AttachmentMeta[]) {
  if (attachments.length === 0) return text;
  const lines = [
    attachmentMarker(attachments),
    text || "请查看我添加的文件。",
    "",
    "附件：",
  ];
  for (const file of attachments) {
    lines.push("", `### ${file.name}`);
    lines.push(`- 类型：${file.type || "unknown"}`);
    lines.push(`- 大小：${formatFileSize(file.size)}`);
    lines.push(`- 在线预览：${file.url}`);
    if (file.workspacePath) {
      lines.push(`- 工作区路径：${file.workspacePath}`);
    }
    if (file.text !== undefined) {
      lines.push("", "```text", file.text.slice(0, 8000), "```");
    } else {
      lines.push("- 内容：已上传，可在在线预览地址查看。");
    }
  }
  return lines.join("\n");
}

function attachmentMarker(attachments: AttachmentMeta[]) {
  return `<!-- sl-attachments:${encodeAttachmentPayload(attachments)} -->`;
}

function encodeAttachmentPayload(attachments: AttachmentMeta[]) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(attachments))));
}

async function readAttachmentDraft(file: File): Promise<AttachmentDraft> {
  const base = {
    id: `file-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    file,
    name: file.name,
    size: file.size,
    type: file.type,
    status: "ready" as const,
  };
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return { ...base, status: "error", error: `文件超过 ${formatFileSize(MAX_ATTACHMENT_BYTES)}` };
  }
  if (!isReadableTextFile(file)) return base;
  if (file.size > 512 * 1024) {
    return { ...base, error: "文本文件超过 512KB，未内联内容" };
  }
  try {
    return { ...base, content: await file.text() };
  } catch {
    return { ...base, error: "文件读取失败" };
  }
}

function isReadableTextFile(file: File) {
  const name = file.name.toLowerCase();
  return (
    file.type.startsWith("text/") ||
    /\.(md|txt|csv|json|yaml|yml|xml|html|css|js|jsx|ts|tsx|py|sh|sql|log)$/i.test(name)
  );
}

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function AttachmentTray({
  attachments,
  onRemove,
}: {
  attachments: AttachmentDraft[];
  onRemove: (id: string) => void;
}) {
  return (
    <div className="border-b border-border/70 px-3 py-2">
      <div className="flex flex-wrap gap-1.5">
        {attachments.map((file) => (
          <div
            key={file.id}
            className="flex max-w-full items-center gap-1.5 rounded-md border border-border bg-bg px-2 py-1 text-[11px] text-fg-muted"
          >
            <Paperclip size={12} className="shrink-0 text-accent" />
            <span className="max-w-[220px] truncate">{file.name}</span>
            <span className="shrink-0 font-mono text-[10px] text-fg-subtle">
              {formatFileSize(file.size)}
            </span>
            <AttachmentStatus file={file} />
            <button
              type="button"
              aria-label="移除附件"
              title="移除附件"
              onClick={() => onRemove(file.id)}
              className="rounded p-0.5 text-fg-subtle transition hover:bg-bg-hover hover:text-fg"
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function AttachmentStatus({ file }: { file: AttachmentDraft }) {
  if (file.status === "uploading") {
    return <span className="shrink-0 font-mono text-[10px] text-warning">上传中</span>;
  }
  if (file.status === "uploaded") {
    return <span className="shrink-0 font-mono text-[10px] text-success">已上传</span>;
  }
  if (file.status === "error" || file.error) {
    return (
      <span className="min-w-0 max-w-[180px] truncate font-mono text-[10px] text-danger" title={file.error}>
        {file.error ?? "上传失败"}
      </span>
    );
  }
  return <span className="shrink-0 font-mono text-[10px] text-fg-subtle">待发送</span>;
}

function formatQuotedMessage(message: TextMessage, body: string) {
  const quoted = message.content
    .trim()
    .split(/\r?\n/)
    .slice(0, 8)
    .map((line) => `> ${line}`)
    .join("\n");
  return `> 引用 ${message.authorName}\n${quoted}\n\n${body}`;
}

function QuotePreview({
  message,
  onClear,
}: {
  message: TextMessage;
  onClear: () => void;
}) {
  return (
    <div className="border-b border-border/70 px-3 py-2">
      <div className="flex items-start gap-2 rounded-md border-l-2 border-accent bg-bg px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium text-fg">引用 {message.authorName}</div>
          <div className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-fg-muted">
            {message.content}
          </div>
        </div>
        <button
          type="button"
          aria-label="取消引用"
          title="取消引用"
          onClick={onClear}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-subtle transition hover:bg-bg-hover hover:text-fg"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}

function MentionPicker({
  agents,
  onSelect,
}: {
  agents: Agent[];
  onSelect: (agent: Agent) => void;
}) {
  return (
    <div className="border-b border-border/70 p-2">
      <div className="max-h-40 overflow-y-auto rounded-md border border-border bg-bg">
        {agents.length === 0 ? (
          <div className="px-3 py-2 text-xs text-fg-subtle">未找到成员</div>
        ) : (
          agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(agent)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-fg-muted transition hover:bg-bg-hover hover:text-fg"
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border bg-bg-elevated text-[10px] text-accent">
                {agent.avatar}
              </span>
              <span className="min-w-0 flex-1 truncate">{agent.name}</span>
              <span className="text-[10px] font-mono text-fg-subtle">{agent.status}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function SkillLauncher({
  conversationId,
  skills,
  sending,
  onPrepare,
}: {
  conversationId: string;
  skills: SkillDefinition[];
  sending: boolean;
  onPrepare: (skill: SkillDefinition) => void;
}) {
  const [selectedId, setSelectedId] = useState("");
  const selectedSkill = useMemo(
    () => skills.find((skill) => skill.id === (selectedId || skills[0]?.id)),
    [selectedId, skills],
  );
  const canPrepare = Boolean(selectedSkill && !sending);

  function prepareSkill() {
    if (!selectedSkill || !canPrepare) return;
    onPrepare(selectedSkill);
  }

  return (
    <div className="min-w-0 border-b border-border/70 p-3">
      <div className="grid min-w-0 grid-cols-1 gap-2">
        <label className="grid min-w-0 gap-1">
          <span className="text-[11px] font-medium text-fg-muted">技能</span>
          <select
            value={selectedSkill?.id ?? ""}
            onChange={(e) => setSelectedId(e.target.value)}
            className="h-9 w-full min-w-0 rounded-md border border-border bg-bg px-2 text-xs text-fg outline-none focus:border-accent/70"
          >
            {skills.map((skill) => (
              <option key={skill.id} value={skill.id}>
                {skill.owner} · {skill.name}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          disabled={!canPrepare}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            prepareSkill();
          }}
          className={cn(
            "h-9 w-full rounded-md px-3 text-xs font-medium transition",
            canPrepare
              ? "bg-accent text-bg-deep hover:shadow-glow-accent"
              : "bg-bg-hover text-fg-subtle cursor-not-allowed opacity-50",
          )}
        >
          分析参数并生成表单
        </button>
      </div>

      {selectedSkill && (
        <div className="mt-2 flex min-w-0 items-start gap-2 text-[11px] text-fg-muted">
          <span className="shrink-0 rounded bg-bg-hover px-1.5 py-0.5 font-mono text-[10px] text-accent">
            {selectedSkill.category}
          </span>
          <span className="min-w-0 line-clamp-2">{selectedSkill.description || selectedSkill.path}</span>
        </div>
      )}
    </div>
  );
}

function ToolButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: ElementType;
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick?.();
      }}
      className={cn(
        "w-7 h-7 rounded-md flex items-center justify-center transition",
        active
          ? "bg-accent/15 text-accent"
          : "text-fg-muted hover:text-fg hover:bg-bg-hover",
      )}
    >
      <Icon size={15} />
    </button>
  );
}
