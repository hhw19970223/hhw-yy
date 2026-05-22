import type {
  Agent,
  Conversation,
  Message,
  ScheduledTaskItem,
  SkillDefinition,
  SkillFormMessage,
  SkillParamField,
  TaskItem,
  ToolLogItem,
  AttachmentMeta,
  AttachmentPreviewData,
} from "@/data/types";

interface ServerAgent {
  id: string;
  name: string;
  role: "manager" | "kol" | "seo" | "social" | "other";
  description: string;
  status: string;
  pid: number | null;
  restartCount: number;
}

interface ServerConversation {
  botId: string;
  chatId: string;
  title: string;
  kind: "private" | "group";
  members: string[];
  icon?: string | null;
  archived?: boolean;
  lastMessageAt: string;
  lastSnippet: string;
  unread: number;
}

interface ServerMessage {
  id: string;
  conversationId: string;
  role: "user" | "agent" | "system";
  authorId: string;
  authorName: string;
  createdAt: string;
  kind: string;
  content: string;
}

const ROLE_AVATAR: Record<string, string> = {
  manager: "经",
  kol: "K",
  seo: "S",
  social: "分",
  other: "?",
};

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit, timeoutMs = 8_000): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

function mapAgentStatus(status: string): Agent["status"] {
  switch (status) {
    case "READY":
      return "online";
    case "STOPPING":
    case "STARTING":
      return "busy";
    case "CRASHED":
      return "restarting";
    case "STOPPED":
    default:
      return "offline";
  }
}

export async function fetchAgents(): Promise<Agent[]> {
  const res = await fetch("/web/agents");
  if (!res.ok) throw new Error(`fetchAgents failed: ${res.status}`);
  const data = (await res.json()) as ServerAgent[];
  return data.map((a) => ({
    id: a.id,
    name: a.name,
    role: (a.role === "other" ? "manager" : a.role) as Agent["role"],
    avatar: ROLE_AVATAR[a.role] ?? a.name.slice(0, 1),
    status: mapAgentStatus(a.status),
    pid: a.pid ?? undefined,
    restartCount: a.restartCount,
    description: a.description,
  }));
}

export async function fetchConversations(): Promise<Conversation[]> {
  const res = await fetch("/web/conversations");
  if (!res.ok) throw new Error(`fetchConversations failed: ${res.status}`);
  const data = (await res.json()) as ServerConversation[];
  return data.map((c) => ({
    id: c.chatId,
    kind: c.kind,
    title: c.title,
    botId: c.botId,
    members: c.members,
    icon: c.icon ?? null,
    archived: Boolean(c.archived),
    lastMessageAt: c.lastMessageAt,
    lastSnippet: c.lastSnippet,
    unread: c.unread,
  }));
}

export async function createConversation(input: {
  title: string;
  kind: "private" | "group";
  botIds: string[];
  icon?: string;
}): Promise<Conversation> {
  const res = await fetchWithTimeout("/web/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`createConversation failed: ${res.status} ${err}`);
  }
  const c = (await res.json()) as ServerConversation;

  return {
    id: c.chatId,
    kind: c.kind,
    title: c.title,
    botId: c.botId,
    members: c.members,
    icon: c.icon ?? null,
    archived: Boolean(c.archived),
    lastMessageAt: c.lastMessageAt,
    lastSnippet: c.lastSnippet,
    unread: c.unread,
  };
}

export async function uploadAttachment(file: File, chatId?: string): Promise<AttachmentMeta> {
  const dataUrl = await readFileAsDataUrl(file);
  const base64 = dataUrl.split(",", 2)[1] ?? "";
  const res = await fetchWithTimeout("/web/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: file.name,
      type: file.type || "application/octet-stream",
      data: base64,
      chatId,
    }),
  }, 120_000);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`uploadAttachment failed: ${res.status} ${err}`);
  }
  return (await res.json()) as AttachmentMeta;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("read file failed"));
    reader.readAsDataURL(file);
  });
}

export async function translateMarkdown(text: string): Promise<string> {
  const res = await fetchWithTimeout("/web/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  }, 30_000);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`translateMarkdown failed: ${res.status} ${err}`);
  }
  const data = (await res.json()) as { text: string };
  return data.text;
}

export async function fetchAttachmentPreview(file: AttachmentMeta): Promise<AttachmentPreviewData> {
  const res = await fetchWithTimeout(`${file.url}/preview`, undefined, 20_000);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`fetchAttachmentPreview failed: ${res.status} ${err}`);
  }
  return (await res.json()) as AttachmentPreviewData;
}

export async function renameConversation(chatId: string, title: string): Promise<Conversation> {
  const res = await fetch(`/web/conversations/${encodeURIComponent(chatId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`renameConversation failed: ${res.status} ${err}`);
  }
  const c = (await res.json()) as ServerConversation;

  return {
    id: c.chatId,
    kind: c.kind,
    title: c.title,
    botId: c.botId,
    members: c.members,
    icon: c.icon ?? null,
    archived: Boolean(c.archived),
    lastMessageAt: c.lastMessageAt,
    lastSnippet: c.lastSnippet,
    unread: c.unread,
  };
}

export async function updateConversationIcon(chatId: string, icon: string): Promise<Conversation> {
  const res = await fetch(`/web/conversations/${encodeURIComponent(chatId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ icon }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`updateConversationIcon failed: ${res.status} ${err}`);
  }
  const c = (await res.json()) as ServerConversation;
  return {
    id: c.chatId,
    kind: c.kind,
    title: c.title,
    botId: c.botId,
    members: c.members,
    icon: c.icon ?? null,
    archived: Boolean(c.archived),
    lastMessageAt: c.lastMessageAt,
    lastSnippet: c.lastSnippet,
    unread: c.unread,
  };
}

export async function archiveConversation(chatId: string): Promise<Conversation> {
  const res = await fetch(`/web/conversations/${encodeURIComponent(chatId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archived: true }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`archiveConversation failed: ${res.status} ${err}`);
  }
  const c = (await res.json()) as ServerConversation;
  return {
    id: c.chatId,
    kind: c.kind,
    title: c.title,
    botId: c.botId,
    members: c.members,
    icon: c.icon ?? null,
    archived: Boolean(c.archived),
    lastMessageAt: c.lastMessageAt,
    lastSnippet: c.lastSnippet,
    unread: c.unread,
  };
}

export async function deleteConversation(chatId: string): Promise<void> {
  const res = await fetch(`/web/conversations/${encodeURIComponent(chatId)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`deleteConversation failed: ${res.status} ${err}`);
  }
}

export async function fetchMessages(botId: string, chatId: string): Promise<Message[]> {
  const url = `/web/messages?chatId=${encodeURIComponent(chatId)}&botId=${encodeURIComponent(botId)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetchMessages failed: ${res.status}`);
  const data = (await res.json()) as ServerMessage[];
  return data.map<Message>((m) => mapServerMessage(m, botId, chatId));
}

function mapServerMessage(m: ServerMessage, botId: string, chatId: string): Message {
  if (m.kind === "skill-form") {
    const parsed = parseSkillFormContent(m.content);
    if (parsed) {
      return {
        id: m.id,
        conversationId: m.conversationId || chatId,
        role: "system",
        authorId: m.authorId || "skill-form",
        authorName: m.authorName || "Skill 参数",
        createdAt: m.createdAt,
        kind: "skill-form",
        skillForm: parsed,
      };
    }
  }
  const restoredSkillForm = restoreSkillPromptMessage(m, botId, chatId);
  if (restoredSkillForm) return restoredSkillForm;
  return {
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    authorId: m.authorId,
    authorName: m.authorName,
    createdAt: m.createdAt,
    kind: "text",
    content: m.content,
    status: "sent",
  };
}

function parseSkillFormContent(content: string): SkillFormMessage["skillForm"] | null {
  try {
    const parsed = JSON.parse(content) as SkillFormMessage["skillForm"];
    if (!parsed?.skill?.id || !Array.isArray(parsed.fields)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function restoreSkillPromptMessage(
  message: ServerMessage,
  botId: string,
  chatId: string,
): SkillFormMessage | null {
  const content = message.content.trim();
  if (!content.includes("使用技能：") || !content.includes("用户已通过交互表单确认以下参数：")) {
    return null;
  }

  const skillName = firstMatch(content, /^使用技能[:：]\s*(.+)$/m);
  const skillPath = firstMatch(content, /^技能路径[:：]\s*(.+)$/m);
  if (!skillName || !skillPath) return null;

  const paramBlock = firstMatch(
    content,
    /用户已通过交互表单确认以下参数：\s*([\s\S]*?)(?:\n\s*请直接按该 SKILL\.md 的流程执行|$)/,
  );
  const fields: SkillParamField[] = [];
  const values: Record<string, string | number> = {};
  for (const rawLine of (paramBlock ?? "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = line.match(/^-?\s*(.+?)(（必填）)?[:：]\s*(.*)$/);
    if (!parsed) continue;
    const label = parsed[1].trim();
    const id = fieldId(label, fields.length);
    const value = parsed[3]?.trim() ?? "";
    fields.push({
      id,
      label,
      type: value.length > 80 ? "textarea" : "input",
      required: Boolean(parsed[2]),
    });
    values[id] = value === "未填写" ? "" : value;
  }

  const skillPathParts = skillPath.split("/");
  const category = skillPathParts.length >= 2 ? skillPathParts[skillPathParts.length - 2] : "skill";

  return {
    id: message.id,
    conversationId: message.conversationId || chatId,
    role: "system",
    authorId: "skill-form",
    authorName: "Skill 参数",
    createdAt: message.createdAt,
    kind: "skill-form",
    skillForm: {
      skill: {
        id: skillPath.replace(/\/SKILL\.md$/, "").replace(/[^a-zA-Z0-9_-]+/g, "-"),
        name: skillName,
        description: "",
        owner: "common",
        category,
        path: skillPath,
      },
      agentId: botId,
      agentName: message.authorName || botId,
      analysisSummary: "已从历史执行提示词还原为 Skill 参数组件。",
      fields,
      status: "submitted",
      values,
    },
  };
}

function firstMatch(text: string, pattern: RegExp): string | null {
  return text.match(pattern)?.[1]?.trim() ?? null;
}

function fieldId(label: string, index: number): string {
  const normalized = label
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || `field-${index + 1}`;
}

export async function postMessage(
  botId: string,
  chatId: string,
  text: string,
  botIds?: string[],
  routeMode?: "default" | "direct_self",
  hiddenUserMessage?: boolean,
): Promise<{
  messageId: string;
  messageIds?: Array<{ botId: string; messageId: string }>;
  scheduledTask?: ScheduledTaskItem | null;
  userMessageId: string;
}> {
  const res = await fetch("/web/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ botId, botIds, chatId, text, routeMode, hiddenUserMessage }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`postMessage failed: ${res.status} ${err}`);
  }
  return (await res.json()) as {
    messageId: string;
    messageIds?: Array<{ botId: string; messageId: string }>;
    scheduledTask?: ScheduledTaskItem | null;
    userMessageId: string;
  };
}

export async function upsertUiMessage(message: Message, preview?: string): Promise<void> {
  if (message.kind !== "skill-form") return;
  const res = await fetchWithTimeout("/web/ui-messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: message.id,
      chatId: message.conversationId,
      role: message.role,
      authorId: message.authorId,
      authorName: message.authorName,
      createdAt: message.createdAt,
      kind: message.kind,
      content: message.skillForm,
      preview,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`upsertUiMessage failed: ${res.status} ${err}`);
  }
}

export async function fetchTasks(): Promise<TaskItem[]> {
  const res = await fetch("/web/tasks");
  if (!res.ok) throw new Error(`fetchTasks failed: ${res.status}`);
  return (await res.json()) as TaskItem[];
}

export async function fetchToolLogs(): Promise<ToolLogItem[]> {
  const res = await fetch("/web/tool-logs");
  if (!res.ok) throw new Error(`fetchToolLogs failed: ${res.status}`);
  return (await res.json()) as ToolLogItem[];
}

export async function fetchScheduledTasks(): Promise<ScheduledTaskItem[]> {
  const res = await fetch("/web/scheduled-tasks");
  if (!res.ok) throw new Error(`fetchScheduledTasks failed: ${res.status}`);
  return (await res.json()) as ScheduledTaskItem[];
}

export async function deleteScheduledTask(id: string): Promise<void> {
  const res = await fetch(`/web/scheduled-tasks/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`deleteScheduledTask failed: ${res.status} ${err}`);
  }
}

export async function fetchSkills(): Promise<SkillDefinition[]> {
  const res = await fetch("/web/skills");
  if (!res.ok) throw new Error(`fetchSkills failed: ${res.status}`);
  return (await res.json()) as SkillDefinition[];
}

export async function analyzeSkill(input: {
  botId: string;
  skillId: string;
}): Promise<{
  skill: SkillDefinition;
  agentId: string;
  agentName: string;
  analysisSummary: string;
  fields: SkillParamField[];
}> {
  const res = await fetchWithTimeout("/web/skills/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }, 30_000);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`analyzeSkill failed: ${res.status} ${err}`);
  }
  return (await res.json()) as {
    skill: SkillDefinition;
    agentId: string;
    agentName: string;
    analysisSummary: string;
    fields: SkillParamField[];
  };
}
