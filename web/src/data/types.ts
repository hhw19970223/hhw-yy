export type AgentStatus = "online" | "busy" | "offline" | "restarting";

export interface Agent {
  id: string;
  name: string;
  role: "manager" | "kol" | "seo" | "social";
  avatar: string;
  status: AgentStatus;
  pid?: number;
  restartCount: number;
  description: string;
}

export type ConversationKind = "private" | "group";

export interface Conversation {
  id: string;
  kind: ConversationKind;
  title: string;
  members: string[];
  botId: string;
  icon?: string | null;
  archived: boolean;
  lastMessageAt: string;
  lastSnippet: string;
  unread: number;
}

export type MessageRole = "user" | "agent" | "system";
export type MessageKind = "text" | "approval" | "task" | "tool-call" | "skill-form";

export interface BaseMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  authorId: string;
  authorName: string;
  createdAt: string;
  kind: MessageKind;
}

export interface TextMessage extends BaseMessage {
  kind: "text";
  content: string;
  streaming?: boolean;
  mentions?: string[];
  status?: "pending" | "sent" | "failed";
  errorMessage?: string;
}

export interface AttachmentMeta {
  id: string;
  name: string;
  type: string;
  size: number;
  url: string;
  workspacePath?: string;
  text?: string;
}

export interface AttachmentPreviewData {
  kind: "text" | "markdown" | "table" | "office" | "presentation";
  text: string;
  rows?: string[][];
}

export interface ApprovalMessage extends BaseMessage {
  kind: "approval";
  approval: {
    id: string;
    title: string;
    risk: "low" | "medium" | "high";
    summary: string;
    payloadPreview: string;
    targets?: string[];
    status: "pending" | "approved" | "rejected" | "expired";
    deadline?: string;
  };
}

export interface TaskMessage extends BaseMessage {
  kind: "task";
  task: {
    id: string;
    title: string;
    state: "queued" | "running" | "blocked" | "done" | "failed";
    owner: string;
    progress?: number;
  };
}

export interface ToolCallMessage extends BaseMessage {
  kind: "tool-call";
  tool: {
    name: string;
    args: Record<string, unknown>;
    result?: string;
    durationMs?: number;
  };
}

export type SkillParamFieldType = "input" | "textarea" | "number" | "select";

export interface SkillParamField {
  id: string;
  label: string;
  type: SkillParamFieldType;
  required: boolean;
  placeholder?: string;
  options?: Array<{ label: string; value: string }>;
}

export interface SkillFormMessage extends BaseMessage {
  kind: "skill-form";
  role: "system";
  skillForm: {
    skill: SkillDefinition;
    agentId: string;
    agentName: string;
    analysisSummary: string;
    fields: SkillParamField[];
    status: "analyzing" | "pending" | "submitting" | "submitted" | "failed" | "cancelled";
    values?: Record<string, string | number>;
    errorMessage?: string;
  };
}

export type Message =
  | TextMessage
  | ApprovalMessage
  | TaskMessage
  | ToolCallMessage
  | SkillFormMessage;

export interface TaskItem {
  id: string;
  title: string;
  owner: string;
  state: "queued" | "running" | "blocked" | "done" | "failed";
  updatedAt: string;
}

export interface ToolLogItem {
  id: string;
  time: string;
  tool: string;
  status: "ok" | "pending" | "error";
}

export interface ScheduledTaskItem {
  id: string;
  chatId: string;
  botIds: string[];
  title: string;
  cron: string;
  prompt: string;
  nextRunAt: string;
  lastRunAt: string | null;
  createdAt: string;
  enabled: boolean;
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  owner: "SEO内容" | "KOL增长" | "社媒分发" | "运营经理" | "common";
  category: string;
  path: string;
}
