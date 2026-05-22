import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Check,
  Copy,
  Wrench,
  ChevronDown,
  AlertTriangle,
  CheckCircle2,
  Quote,
  X,
  Clock,
  FileText,
  Languages,
  Download,
  Table2,
  Presentation,
} from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { Avatar } from "./Avatar";
import { useStore } from "@/store";
import type { AttachmentMeta, AttachmentPreviewData, Message, SkillFormMessage, SkillParamField } from "@/data/types";
import { fetchAttachmentPreview, translateMarkdown } from "@/api/rest";

function formatTime(iso: string) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}

export function MessageBubble({
  msg,
  onQuote,
}: {
  msg: Message;
  onQuote?: (msg: Extract<Message, { kind: "text" }>) => void;
}) {
  const isMe = msg.role === "user";
  const agents = useStore((s) => s.agents);
  const agent = agents.find((a) => a.id === msg.authorId);

  return (
    <div
      className={cn(
        "flex gap-3 px-6 py-2 group hover:bg-bg-elevated/40 transition",
        isMe && "flex-row-reverse"
      )}
    >
      <Avatar
        role={agent?.role ?? "user"}
        size="md"
      />
      <div
        className={cn(
          "flex-1 min-w-0 max-w-[720px]",
          isMe && "flex flex-col items-end"
        )}
      >
        <div
          className={cn(
            "flex items-baseline gap-2 mb-1",
            isMe && "flex-row-reverse"
          )}
        >
          <span className="text-xs font-medium">{msg.authorName}</span>
          <span className="text-[10px] font-mono text-fg-subtle">
            {formatTime(msg.createdAt)}
          </span>
        </div>
        {msg.kind === "text" && <TextBody msg={msg} isMe={isMe} onQuote={onQuote} />}
        {msg.kind === "tool-call" && <ToolCallCard msg={msg} />}
        {msg.kind === "approval" && <ApprovalCard msg={msg} />}
        {msg.kind === "task" && <TaskCard msg={msg} />}
        {msg.kind === "skill-form" && <SkillFormCard msg={msg} />}
      </div>
    </div>
  );
}

/* ─── Text Bubble ─── */
function TextBody({
  msg,
  isMe,
  onQuote,
}: {
  msg: Extract<Message, { kind: "text" }>;
  isMe: boolean;
  onQuote?: (msg: Extract<Message, { kind: "text" }>) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [translatedMarkdown, setTranslatedMarkdown] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  const [translateError, setTranslateError] = useState("");
  const parsed = parseQuotedMessage(msg.content);
  const attachmentParsed = parseAttachments(parsed?.body ?? msg.content);
  const markdownContent = attachmentParsed.body;
  const visibleMarkdown = translatedMarkdown ?? markdownContent;

  async function copyText() {
    try {
      await navigator.clipboard.writeText(msg.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  async function toggleTranslation() {
    if (translatedMarkdown) {
      setTranslatedMarkdown(null);
      setTranslateError("");
      return;
    }
    if (translating) return;
    setTranslating(true);
    setTranslateError("");
    try {
      const translated = await translateMarkdown(markdownContent);
      setTranslatedMarkdown(translated);
    } catch (err) {
      setTranslateError(err instanceof Error ? err.message : "翻译失败");
    } finally {
      setTranslating(false);
    }
  }

  return (
    <div className={cn("relative group/body flex w-fit max-w-full min-w-0", isMe && "justify-end")}>
      <div
        className={cn(
          "min-w-0 max-w-full overflow-hidden rounded-2xl px-4 py-2.5 text-[13px] leading-relaxed",
          isMe
            ? "bg-accent-soft border border-accent/30 rounded-br-sm"
            : "bg-bg-elevated border border-border rounded-bl-sm"
        )}
      >
        {parsed && (
          <div className="mb-2 rounded-md border-l-2 border-accent bg-bg px-3 py-2">
            <div className="text-[11px] font-medium text-fg">引用 {parsed.authorName}</div>
            <div className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-xs leading-relaxed text-fg-muted">
              {parsed.quote}
            </div>
          </div>
        )}
        {attachmentParsed.attachments.length > 0 && (
          <AttachmentPreviewGrid attachments={attachmentParsed.attachments} />
        )}
        <div className="markdown-body">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ children, href }) => (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              ),
              table: ({ children }) => (
                <div className="markdown-table-scroll">
                  <table>{children}</table>
                </div>
              ),
            }}
          >
            {visibleMarkdown}
          </ReactMarkdown>
        </div>
        {translateError && (
          <div className="mt-2 text-[11px] text-danger">
            {translateError}
          </div>
        )}
        {msg.streaming && <span className="streaming-cursor" />}
      </div>
      <div
        className={cn(
          "absolute top-0 flex translate-y-[-70%] gap-1 rounded-md border border-border bg-bg-elevated p-1 opacity-0 shadow-lg transition group-hover/body:opacity-100",
          isMe ? "right-1" : "left-1",
        )}
      >
        <MessageAction
          label={copied ? "已复制" : "复制"}
          onClick={() => void copyText()}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </MessageAction>
        <MessageAction
          label="引用"
          onClick={() => onQuote?.(msg)}
        >
          <Quote size={12} />
        </MessageAction>
        <MessageAction
          label={translatedMarkdown ? "显示原文" : translating ? "翻译中" : "翻译成中文"}
          disabled={translating || !markdownContent.trim()}
          onClick={() => void toggleTranslation()}
        >
          <Languages size={12} />
        </MessageAction>
      </div>
    </div>
  );
}

function parseAttachments(content: string): { attachments: AttachmentMeta[]; body: string } {
  const match = content.match(/^\s*<!--\s*sl-attachments:([A-Za-z0-9+/=]+)\s*-->\s*/);
  if (!match) return { attachments: [], body: content };
  try {
    const json = decodeURIComponent(escape(atob(match[1])));
    return {
      attachments: JSON.parse(json) as AttachmentMeta[],
      body: content.slice(match[0].length).trimStart(),
    };
  } catch {
    return { attachments: [], body: content.replace(match[0], "").trimStart() };
  }
}

function AttachmentPreviewGrid({ attachments }: { attachments: AttachmentMeta[] }) {
  return (
    <div className="mb-3 space-y-2">
      {attachments.map((file) => (
        <AttachmentPreview key={file.id} file={file} />
      ))}
    </div>
  );
}

function AttachmentPreview({ file }: { file: AttachmentMeta }) {
  const kind = attachmentKind(file);
  if (kind === "image") {
    return (
      <PreviewFrame file={file}>
        <img src={file.url} alt={file.name} className="max-h-[360px] w-full rounded-md object-contain" />
      </PreviewFrame>
    );
  }
  if (kind === "video") {
    return (
      <PreviewFrame file={file}>
        <video src={file.url} controls className="max-h-[360px] w-full rounded-md" />
      </PreviewFrame>
    );
  }
  if (kind === "pdf" || kind === "html") {
    return (
      <PreviewFrame file={file}>
        <iframe
          src={file.url}
          title={file.name}
          sandbox={kind === "html" ? "allow-same-origin" : undefined}
          className="h-[360px] w-full rounded-md border border-border bg-white"
        />
      </PreviewFrame>
    );
  }
  if (kind === "markdown") {
    return (
      <PreviewFrame file={file}>
        {file.text !== undefined
          ? <MarkdownAttachmentPreview text={file.text} />
          : <RemoteAttachmentPreview file={file} />}
      </PreviewFrame>
    );
  }
  if (kind === "table") {
    return (
      <PreviewFrame file={file}>
        {file.text !== undefined
          ? <CsvPreview text={file.text} />
          : <RemoteAttachmentPreview file={file} />}
      </PreviewFrame>
    );
  }
  if (kind === "presentation" || kind === "office" || kind === "file") {
    return (
      <PreviewFrame file={file}>
        <RemoteAttachmentPreview file={file} />
      </PreviewFrame>
    );
  }
  return (
    <PreviewFrame file={file}>
      <a
        href={file.url}
        download={file.name}
        className="flex items-center gap-2 rounded-md border border-border bg-bg px-3 py-3 text-xs text-fg-muted hover:text-accent"
      >
        <FileText size={16} />
        <span className="min-w-0 flex-1 truncate">
          下载文件
        </span>
        <Download size={14} />
      </a>
    </PreviewFrame>
  );
}

function RemoteAttachmentPreview({ file }: { file: AttachmentMeta }) {
  const [preview, setPreview] = useState<AttachmentPreviewData | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setStatus("loading");
    setError("");
    fetchAttachmentPreview(file)
      .then((data) => {
        if (!alive) return;
        setPreview(data);
        setStatus("ready");
      })
      .catch((err) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : "无法生成预览");
        setStatus("failed");
      });
    return () => {
      alive = false;
    };
  }, [file.id, file.url]);

  if (status === "loading") {
    return (
      <div className="rounded-md border border-border bg-bg px-3 py-3 text-xs text-fg-subtle">
        正在生成在线预览…
      </div>
    );
  }

  if (status === "failed" || !preview) {
    return (
      <div className="rounded-md border border-border bg-bg px-3 py-3 text-xs text-fg-muted">
        <div>暂时无法在线预览该文件。</div>
        {error && <div className="mt-1 font-mono text-[10px] text-fg-subtle">{error}</div>}
      </div>
    );
  }

  if (preview.kind === "markdown") return <MarkdownAttachmentPreview text={preview.text} />;
  if (preview.kind === "table") return <RowsPreview rows={preview.rows ?? parseDelimited(preview.text)} />;
  if (preview.kind === "presentation") return <PresentationPreview text={preview.text} />;
  return <PlainTextPreview text={preview.text} />;
}

function MarkdownAttachmentPreview({ text }: { text: string }) {
  return (
    <div className="max-h-[360px] overflow-y-auto rounded-md border border-border bg-bg px-3 py-2">
      <div className="markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text || "暂无可预览内容"}</ReactMarkdown>
      </div>
    </div>
  );
}

function PlainTextPreview({ text }: { text: string }) {
  return (
    <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-bg px-3 py-2 text-xs leading-relaxed text-fg-muted">
      {text || "暂无可预览内容"}
    </pre>
  );
}

function PresentationPreview({ text }: { text: string }) {
  const slides = splitSlides(text);
  return (
    <div className="max-h-[360px] overflow-y-auto rounded-md border border-border bg-bg">
      {slides.length === 0 ? (
        <div className="px-3 py-3 text-xs text-fg-subtle">暂无可预览幻灯片文本</div>
      ) : (
        <div className="space-y-2 p-2">
          {slides.map((slide, index) => (
            <div key={index} className="rounded-md border border-border bg-bg-elevated px-3 py-2">
              <div className="mb-1 flex items-center gap-1.5 text-[10px] font-mono uppercase text-accent">
                <Presentation size={12} />
                Slide {index + 1}
              </div>
              <pre className="whitespace-pre-wrap text-xs leading-relaxed text-fg-muted">{slide}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PreviewFrame({
  file,
  children,
}: {
  file: AttachmentMeta;
  children: React.ReactNode;
}) {
  const kind = attachmentKind(file);
  const HeaderIcon = kind === "table" ? Table2 : kind === "presentation" ? Presentation : FileText;
  return (
    <div className="rounded-md border border-border bg-bg-elevated p-2">
      <div className="mb-2 flex items-center gap-2 text-xs">
        <HeaderIcon size={14} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate font-medium text-fg">{file.name}</span>
        <span className="shrink-0 font-mono text-[10px] text-fg-subtle">{formatFileSize(file.size)}</span>
        <a href={file.url} download={file.name} title="下载文件" className="text-fg-subtle hover:text-accent">
          <Download size={13} />
        </a>
      </div>
      {children}
    </div>
  );
}

function CsvPreview({ text }: { text: string }) {
  const rows = parseDelimited(text).slice(0, 12);
  return <RowsPreview rows={rows} />;
}

function RowsPreview({ rows }: { rows: string[][] }) {
  if (rows.length === 0) {
    return <div className="rounded-md border border-border bg-bg px-3 py-2 text-xs text-fg-subtle">暂无可预览表格内容</div>;
  }
  return (
    <div className="max-h-[320px] overflow-auto rounded-md border border-border bg-bg">
      <table className="w-full min-w-[360px] border-collapse text-left text-[11px]">
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-border last:border-b-0">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="border-r border-border px-2 py-1.5 text-fg-muted last:border-r-0">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function parseDelimited(text: string): string[][] {
  const delimiter = text.includes("\t") ? "\t" : ",";
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split(delimiter).map((cell) => cell.trim().replace(/^"|"$/g, "")));
}

function attachmentKind(file: AttachmentMeta): "image" | "video" | "pdf" | "html" | "markdown" | "table" | "presentation" | "office" | "file" {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.includes("pdf") || name.endsWith(".pdf")) return "pdf";
  if (type.includes("html") || /\.(html|htm)$/.test(name)) return "html";
  if (name.endsWith(".md") || type.includes("markdown")) return "markdown";
  if (
    /\.(csv|tsv|xls|xlsx)$/.test(name) ||
    type.includes("csv") ||
    type.includes("spreadsheet") ||
    type.includes("excel") ||
    type.includes("tab-separated")
  ) return "table";
  if (/\.(ppt|pptx)$/.test(name) || type.includes("presentation") || type.includes("powerpoint")) return "presentation";
  if (/\.(doc|docx)$/.test(name)) return "office";
  return "file";
}

function splitSlides(text: string): string[] {
  const normalized = text.replace(/\r/g, "").trim();
  if (!normalized) return [];
  const explicit = normalized
    .split(/\n\s*(?:---+|={3,}|Slide\s+\d+[:：]?)\s*\n/i)
    .map((part) => part.trim())
    .filter(Boolean);
  if (explicit.length > 1) return explicit.slice(0, 20);

  const lines = normalized.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const slides: string[] = [];
  for (let index = 0; index < lines.length; index += 8) {
    slides.push(lines.slice(index, index + 8).join("\n"));
  }
  return slides.slice(0, 20);
}

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function parseQuotedMessage(content: string): {
  authorName: string;
  quote: string;
  body: string;
} | null {
  const lines = content.split(/\r?\n/);
  const first = lines[0]?.match(/^>\s*引用\s+(.+)$/);
  if (!first) return null;

  const quoteLines: string[] = [];
  let index = 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "") {
      index += 1;
      break;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (!quote) break;
    quoteLines.push(quote[1] ?? "");
  }

  const body = lines.slice(index).join("\n").trim();
  if (quoteLines.length === 0 || !body) return null;
  return {
    authorName: first[1],
    quote: quoteLines.join("\n").trim(),
    body,
  };
}

function MessageAction({
  label,
  onClick,
  disabled = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-6 w-6 items-center justify-center rounded text-fg-subtle transition hover:bg-bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function SkillFormCard({ msg }: { msg: SkillFormMessage }) {
  const submitSkillRunForm = useStore((s) => s.submitSkillRunForm);
  const cancelSkillRunForm = useStore((s) => s.cancelSkillRunForm);
  const { skillForm } = msg;
  const [values, setValues] = useState<Record<string, string | number>>(
    skillForm.values ?? {},
  );
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const missingRequired = skillForm.fields.filter((field) => {
    const value = values[field.id];
    return field.required && (value === undefined || String(value).trim() === "");
  });
  const locked = skillForm.status !== "pending";
  const showFields = skillForm.fields.length > 0;
  const showActions = skillForm.status === "pending" || skillForm.status === "submitting";

  function updateValue(field: SkillParamField, value: string) {
    setValues((current) => ({
      ...current,
      [field.id]: field.type === "number" && value !== "" ? Number(value) : value,
    }));
  }

  async function submit() {
    const nextTouched = Object.fromEntries(
      skillForm.fields.map((field) => [field.id, true]),
    );
    setTouched(nextTouched);
    if (missingRequired.length > 0 || locked) return;
    await submitSkillRunForm(msg.conversationId, msg.id, values);
  }

  function cancel() {
    if (skillForm.status !== "pending") return;
    cancelSkillRunForm(msg.conversationId, msg.id, values);
  }

  return (
    <div className="w-full max-w-[560px] rounded-[10px] border border-accent/25 bg-bg-elevated shadow-[inset_0_0_18px_rgba(34,211,238,0.04)]">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-start gap-2">
          <SparklesBadge />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-fg">
              {skillFormTitle(skillForm.status)}
            </div>
            <div className="mt-0.5 text-[11px] font-mono text-fg-muted">
              使用 Skill：{skillForm.skill.name}
            </div>
            <div className="mt-0.5 truncate text-[10px] font-mono text-fg-subtle">
              {skillForm.agentName} · {skillForm.skill.path}
            </div>
          </div>
          <span className="rounded bg-accent/12 px-2 py-0.5 text-[10px] font-mono text-accent">
            {statusLabel(skillForm.status)}
          </span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-fg-muted">
          {skillForm.analysisSummary}
        </p>
      </div>

      <div className="space-y-3 px-4 py-3">
        {!showFields && (
          <div className="rounded-md border border-border bg-bg px-3 py-2 text-xs text-fg-muted">
            {skillForm.status === "analyzing" ? "Agent 正在分析参数…" : "暂无可填写参数"}
          </div>
        )}
        {skillForm.fields.map((field) => {
          const value = values[field.id] ?? "";
          const showError =
            field.required && touched[field.id] && String(value).trim() === "";
          return (
            <label key={field.id} className="grid gap-1.5">
              <span className="flex items-center gap-1 text-[11px] font-medium text-fg-muted">
                {field.label}
                {field.required && <span className="text-danger">*</span>}
              </span>
              <SkillFieldInput
                field={field}
                value={value}
                disabled={locked}
                onBlur={() => setTouched((current) => ({ ...current, [field.id]: true }))}
                onChange={(next) => updateValue(field, next)}
              />
              {showError && (
                <span className="text-[10px] text-danger">该参数必须填写</span>
              )}
            </label>
          );
        })}
        {skillForm.errorMessage && (
          <div className="rounded border border-danger/30 bg-danger/10 px-2 py-1.5 text-[11px] text-danger">
            {skillForm.errorMessage}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-border px-4 py-3">
        <span className="min-w-0 flex-1 truncate text-[10px] font-mono text-fg-subtle">
          {skillForm.status === "submitted"
            ? "参数已确认，组件已锁定"
            : skillForm.status === "cancelled"
              ? "已取消，组件已锁定"
            : "特殊交互消息，不支持复制和引用"}
        </span>
        {showActions && (
          <button
            type="button"
            disabled={skillForm.status !== "pending"}
            onClick={cancel}
            className="h-8 rounded-md border border-border bg-bg px-3 text-xs font-medium text-fg-muted transition hover:border-fg-subtle hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            取消
          </button>
        )}
        {showActions && (
          <button
            type="button"
            disabled={locked}
            onClick={() => void submit()}
            className={cn(
              "h-8 rounded-md px-3 text-xs font-medium transition",
              !locked && missingRequired.length === 0
                ? "bg-accent text-bg-deep hover:shadow-glow-accent"
                : "bg-bg-hover text-fg-subtle opacity-60",
            )}
          >
            {skillForm.status === "submitting" ? "提交中…" : "确认并执行"}
          </button>
        )}
      </div>
    </div>
  );
}

function SkillFieldInput({
  field,
  value,
  disabled,
  onBlur,
  onChange,
}: {
  field: SkillParamField;
  value: string | number;
  disabled: boolean;
  onBlur: () => void;
  onChange: (value: string) => void;
}) {
  const baseClass =
    "w-full rounded-md border border-border bg-bg px-3 text-xs text-fg outline-none transition placeholder:text-fg-subtle focus:border-accent/70 disabled:cursor-not-allowed disabled:opacity-60";
  if (field.type === "textarea") {
    return (
      <textarea
        value={String(value)}
        disabled={disabled}
        rows={3}
        placeholder={field.placeholder}
        onBlur={onBlur}
        onChange={(event) => onChange(event.target.value)}
        className={cn(baseClass, "resize-none py-2")}
      />
    );
  }
  if (field.type === "select") {
    return (
      <select
        value={String(value)}
        disabled={disabled}
        onBlur={onBlur}
        onChange={(event) => onChange(event.target.value)}
        className={cn(baseClass, "h-9")}
      >
        <option value="">请选择</option>
        {(field.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      type={field.type === "number" ? "number" : "text"}
      value={String(value)}
      disabled={disabled}
      placeholder={field.placeholder}
      onBlur={onBlur}
      onChange={(event) => onChange(event.target.value)}
      className={cn(baseClass, "h-9")}
    />
  );
}

function SparklesBadge() {
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-accent/30 bg-accent-soft text-accent">
      <CheckCircle2 size={15} />
    </div>
  );
}

function skillFormTitle(status: SkillFormMessage["skillForm"]["status"]) {
  if (status === "submitted") return "已使用 Skill 执行";
  if (status === "cancelled") return "已取消 Skill 执行";
  return "技能参数确认";
}

function statusLabel(status: SkillFormMessage["skillForm"]["status"]) {
  if (status === "analyzing") return "分析中";
  if (status === "submitting") return "执行中";
  if (status === "submitted") return "已提交";
  if (status === "cancelled") return "已取消";
  if (status === "failed") return "失败";
  return "待确认";
}

/* ─── Tool Call Card ─── */
function ToolCallCard({
  msg,
}: {
  msg: Extract<Message, { kind: "tool-call" }>;
}) {
  const [open, setOpen] = useState(false);
  const hasResult = Boolean(msg.tool.result);

  return (
    <div className="rounded-[10px] border border-border bg-bg-elevated text-sm overflow-hidden inline-block max-w-[420px]">
      <button
        className="flex items-center gap-2 px-3 py-2 hover:bg-bg-hover w-full transition"
        onClick={() => setOpen((v) => !v)}
      >
        <Wrench size={14} className="text-accent shrink-0" />
        <code className="font-mono text-[11px] text-fg">{msg.tool.name}</code>
        {msg.tool.durationMs && (
          <span className="text-[10px] font-mono text-fg-subtle">
            · {(msg.tool.durationMs / 1000).toFixed(1)}s
          </span>
        )}
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full ml-auto shrink-0",
            hasResult ? "bg-success shadow-glow-success" : "bg-warning animate-pulse-soft"
          )}
        />
        <ChevronDown
          size={12}
          className={cn(
            "text-fg-subtle transition-transform shrink-0",
            open && "rotate-180"
          )}
        />
      </button>
      {open && (
        <div className="px-3 pb-3 pt-2 border-t border-border bg-bg/40">
          <div className="text-[10px] font-mono text-fg-subtle mb-1">参数</div>
          <pre className="font-mono text-[11px] leading-relaxed text-fg-muted bg-bg-deep p-2 rounded-md overflow-x-auto">
            {JSON.stringify(msg.tool.args, null, 2)}
          </pre>
          {msg.tool.result && (
            <>
              <div className="text-[10px] font-mono text-fg-subtle mt-2 mb-1">
                结果
              </div>
              <div className="text-xs text-fg-muted">{msg.tool.result}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Approval Card ─── */
function ApprovalCard({
  msg,
}: {
  msg: Extract<Message, { kind: "approval" }>;
}) {
  const { approval } = msg;
  const [status, setStatus] = useState(approval.status);
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [rejectNote, setRejectNote] = useState("");

  if (status !== "pending") {
    return <ApprovalResolved status={status} />;
  }

  const isHigh = approval.risk === "high";
  const isMedium = approval.risk === "medium";

  return (
    <div
      className={cn(
        "rounded-2xl p-4 max-w-[440px] border relative overflow-hidden",
        isHigh &&
          "border-danger/40 bg-[rgba(15,10,10,0.8)] shadow-glow-danger",
        isMedium &&
          "border-warning/30 bg-[rgba(20,15,10,0.6)] shadow-glow-warning",
        !isHigh && !isMedium && "border-border bg-bg-elevated"
      )}
    >
      {/* Header */}
      <div className="flex items-start gap-2.5 mb-3">
        <AlertTriangle
          size={16}
          className={cn(
            "mt-0.5 shrink-0",
            isHigh ? "text-danger" : isMedium ? "text-warning" : "text-fg-muted"
          )}
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-fg">{approval.title}</div>
          <div className="text-xs text-fg-muted mt-0.5">
            {approval.summary}
          </div>
        </div>
        <span
          className={cn(
            "text-[9px] font-mono font-semibold uppercase tracking-[0.06em] px-1.5 py-0.5 rounded shrink-0",
            isHigh && "bg-danger/20 text-danger",
            isMedium && "bg-warning/20 text-warning",
            !isHigh && !isMedium && "bg-fg-subtle/20 text-fg-muted"
          )}
        >
          {approval.risk}
        </span>
      </div>

      {/* Preview */}
      <div className="text-[10px] font-mono text-fg-subtle mb-1.5">
        文案预览
      </div>
      <div className="text-xs text-fg-muted italic bg-bg border border-border rounded-md px-3 py-2">
        {approval.payloadPreview}
      </div>

      {/* Targets */}
      {approval.targets && (
        <>
          <div className="text-[10px] font-mono text-fg-subtle mt-3 mb-1.5">
            目标
          </div>
          <div className="flex flex-wrap gap-1">
            {approval.targets.map((t, i) => (
              <span
                key={i}
                className="text-[11px] font-mono px-2 py-0.5 rounded bg-bg border border-border text-fg-muted"
              >
                {t}
              </span>
            ))}
          </div>
        </>
      )}

      {/* Actions */}
      <div className="flex gap-2 mt-4">
        <button
          onClick={() => setStatus("approved")}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-[10px] bg-success/12 text-success border border-success/30 hover:bg-success/20 hover:shadow-glow-success text-[13px] font-medium transition"
        >
          <CheckCircle2 size={14} /> 通过
        </button>
        <button
          onClick={() => setShowRejectInput(true)}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-[10px] bg-bg-elevated border border-border text-fg-muted hover:bg-bg-hover hover:text-fg text-[13px] font-medium transition"
        >
          <X size={14} /> 驳回
        </button>
      </div>

      {/* Inline reject input */}
      {showRejectInput && (
        <div className="flex gap-1.5 mt-2 animate-[fadeIn_0.15s_ease-out]">
          <input
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            placeholder="驳回原因(必填)…"
            className="flex-1 bg-bg border border-border rounded-md px-2.5 py-1.5 text-xs text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none"
            autoFocus
          />
          <button
            onClick={() => {
              if (rejectNote.trim()) setStatus("rejected");
            }}
            className="px-3 py-1.5 rounded-md bg-danger border-none text-white text-[11px] font-medium hover:shadow-glow-danger transition"
          >
            提交
          </button>
        </div>
      )}

      {/* Timer */}
      {approval.deadline && (
        <div className="text-[10px] font-mono text-fg-subtle text-center mt-2.5">
          5 分钟内未审批将自动驳回
        </div>
      )}
    </div>
  );
}

function ApprovalResolved({
  status,
}: {
  status: "approved" | "rejected" | "expired";
}) {
  const config = {
    approved: {
      icon: CheckCircle2,
      color: "text-success border-success/30",
      label: "已通过",
    },
    rejected: {
      icon: X,
      color: "text-danger border-danger/30",
      label: "已驳回",
    },
    expired: {
      icon: Clock,
      color: "text-fg-muted border-border opacity-60",
      label: "已过期 · 自动驳回",
    },
  }[status];

  const Icon = config.icon;

  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 px-3.5 py-2.5 rounded-[10px] border bg-bg-elevated text-xs",
        config.color
      )}
    >
      <Icon size={14} />
      <span>{config.label}</span>
    </div>
  );
}

/* ─── Task Card ─── */
function TaskCard({ msg }: { msg: Extract<Message, { kind: "task" }> }) {
  const { task } = msg;
  const stateStyles: Record<typeof task.state, string> = {
    queued: "bg-fg-subtle/20 text-fg-muted",
    running: "bg-accent/15 text-accent",
    blocked: "bg-warning/15 text-warning",
    done: "bg-success/15 text-success",
    failed: "bg-danger/15 text-danger",
  };

  return (
    <div className="rounded-[10px] border border-border bg-bg-elevated p-3 max-w-sm inline-block">
      <div className="flex items-center gap-2 text-[11px] font-mono text-fg-muted mb-1">
        <span>#{task.id}</span>
        <span>·</span>
        <span>{task.owner}</span>
        <span
          className={cn(
            "ml-auto px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-[0.04em]",
            stateStyles[task.state]
          )}
        >
          {task.state}
        </span>
      </div>
      <div className="text-[13px] font-medium">{task.title}</div>
      {task.progress !== undefined && (
        <div className="mt-2 h-[3px] bg-bg rounded-full overflow-hidden">
          <div
            className="h-full bg-accent rounded-full shadow-glow-accent-sm transition-all"
            style={{ width: `${task.progress * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}
