import { create } from "zustand";
import type { Agent, Conversation, DecisionMessage, DecisionOption, Message, ScheduledTaskItem, SkillDefinition, SkillFormMessage, SkillParamField, TaskItem, TextMessage, ToolLogItem } from "@/data/types";
import {
  archiveConversation,
  deleteScheduledTask,
  fetchAgents,
  createConversation,
  deleteConversation,
  fetchConversations,
  fetchMessages,
  fetchSkills,
  fetchScheduledTasks,
  fetchTasks,
  fetchToolLogs,
  analyzeSkill,
  postMessage,
  renameConversation,
  updateConversationIcon,
  upsertUiMessage,
} from "@/api/rest";
import { streamClient, type ConnectionState, type ServerEvent } from "@/api/ws";

interface State {
  agents: Agent[];
  conversations: Conversation[];
  messagesByConversation: Record<string, Message[]>;
  loadedConversations: Set<string>;
  typingByConversation: Record<string, string[]>; // chatId → list of botIds currently typing
  tasks: TaskItem[];
  toolLogs: ToolLogItem[];
  scheduledTasks: ScheduledTaskItem[];
  skills: SkillDefinition[];
  connection: ConnectionState;
  ready: boolean;

  bootstrap: () => Promise<void>;
  createGroupConversation: (title: string, botIds: string[], icon?: string) => Promise<string>;
  createPrivateSession: (botId: string) => Promise<string>;
  renameTask: (chatId: string, title: string) => Promise<void>;
  updateTaskIcon: (chatId: string, icon: string) => Promise<void>;
  archiveTask: (chatId: string) => Promise<void>;
  deleteTask: (chatId: string) => Promise<void>;
  deleteScheduledTask: (id: string) => Promise<void>;
  refreshScheduledTasks: () => Promise<void>;
  ensureMessages: (chatId: string) => Promise<void>;
  sendMessage: (chatId: string, text: string) => Promise<void>;
  addSkillRunForm: (chatId: string, skill: SkillDefinition) => Promise<void>;
  submitSkillRunForm: (chatId: string, formMessageId: string, values: Record<string, string | number>) => Promise<void>;
  cancelSkillRunForm: (chatId: string, formMessageId: string, values?: Record<string, string | number>) => void;
  submitDecision: (chatId: string, decisionMessageId: string, optionId: string, customResponse?: string) => Promise<void>;
  submitDecisionBatch: (chatId: string, decisions: Array<{ decisionMessageId: string; optionId: string; customResponse?: string }>) => Promise<void>;
  cancelDecision: (chatId: string, decisionMessageId: string) => void;
  applyEvent: (event: ServerEvent) => void;
  setConnection: (state: ConnectionState) => void;
}

function nowIso(): string {
  return new Date().toISOString();
}

function clientId(): string {
  // Using Math.random for non-crypto unique-enough ids
  return `c-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

function timeLabel(): string {
  const date = new Date();
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function statusFromString(s: string): Agent["status"] {
  switch (s) {
    case "READY":
      return "online";
    case "STOPPING":
    case "STARTING":
      return "busy";
    case "CRASHED":
      return "restarting";
    default:
      return "offline";
  }
}

function messageTargets(text: string, conv: Conversation, agents: Agent[]): {
  botIds: string[];
  routeMode: "default" | "direct_self";
} {
  if (conv.kind !== "group") return { botIds: [conv.botId], routeMode: "default" };
  const members = conv.members
    .map((memberId) => agents.find((agent) => agent.id === memberId))
    .filter((agent): agent is Agent => Boolean(agent));
  const hits = members
    .filter((agent) => text.includes(`@${agent.name}`) || text.includes(`@${agent.id}`))
    .map((agent) => agent.id);
  if (hits.length > 0) return { botIds: Array.from(new Set(hits)), routeMode: "direct_self" };
  if (isCollectiveGroupRequest(text)) {
    return { botIds: orderGroupTargets(members), routeMode: "direct_self" };
  }
  return { botIds: [defaultGroupOwnerId(conv, agents)], routeMode: "default" };
}

function defaultGroupOwnerId(conv: Conversation, agents: Agent[]): string {
  const manager = conv.members
    .map((memberId) => agents.find((agent) => agent.id === memberId))
    .find((agent) =>
      agent?.role === "manager" ||
      agent?.name.includes("产品经理") ||
      agent?.id.includes("产品经理"),
    );
  return manager?.id ?? conv.botId;
}

function orderGroupTargets(agents: Agent[]): string[] {
  const manager = agents.find((agent) =>
    agent.role === "manager" ||
    agent.name.includes("产品经理") ||
    agent.id.includes("产品经理"),
  );
  return manager
    ? [manager.id, ...agents.filter((agent) => agent.id !== manager.id).map((agent) => agent.id)]
    : agents.map((agent) => agent.id);
}

function isCollectiveGroupRequest(text: string): boolean {
  return /(各个|每个|所有|全部|大家|各位).{0,12}(agent|Agent|成员|机器人|助手)|(@所有人|@all)/i.test(text);
}

function buildSkillExecutionPrompt(
  skill: SkillDefinition,
  conversationId: string,
  fields: SkillParamField[],
  values: Record<string, string | number>,
): string {
  const paramLines = fields.map((field) => {
    const value = values[field.id];
    const rendered = value === undefined || value === "" ? "未填写" : String(value);
    return `- ${field.label}${field.required ? "（必填）" : ""}: ${rendered}`;
  });
  return [
    `使用技能：${skill.name}`,
    `技能路径：${skill.path}`,
    `当前任务：${conversationId}`,
    "",
    "用户已通过交互表单确认以下参数：",
    ...paramLines,
    "",
    "请直接按该 SKILL.md 的流程执行。除非存在安全风险或必需凭证缺失，否则不要再要求用户重复填写这些参数。",
  ].join("\n");
}

function skillFormPreview(message: SkillFormMessage): string {
  const status = message.skillForm.status;
  if (status === "submitted") return `已使用 Skill：${message.skillForm.skill.name}`;
  if (status === "cancelled") return `已取消 Skill：${message.skillForm.skill.name}`;
  if (status === "failed") return `Skill 参数分析失败：${message.skillForm.skill.name}`;
  return `Skill 参数待确认：${message.skillForm.skill.name}`;
}

async function persistSkillForm(message: SkillFormMessage): Promise<void> {
  try {
    await upsertUiMessage(message, skillFormPreview(message));
  } catch (err) {
    console.warn("persist skill form failed", err);
  }
}

function decisionPreview(message: DecisionMessage): string {
  const { decision } = message;
  if (decision.status === "submitted") {
    const selected = decision.options.find((option) => option.id === decision.selectedOptionId);
    return `已选择：${selected?.label ?? decision.customResponse ?? "自定义回复"}`;
  }
  if (decision.status === "cancelled") return `已取消决策：${decision.title}`;
  return `待决策：${decision.title}`;
}

async function persistDecision(message: DecisionMessage): Promise<void> {
  try {
    await upsertUiMessage(message, decisionPreview(message));
  } catch (err) {
    console.warn("persist decision failed", err);
  }
}

function analyzeDecisionMessage(message: TextMessage): DecisionMessage | null {
  const text = message.content.trim();
  if (!text || message.role !== "agent") return null;

  const marked = extractDecisionMarker(text);
  const detected = marked ?? inferDecisionFromText(text);
  if (!detected) return null;

  return {
    id: `${message.id}:decision`,
    conversationId: message.conversationId,
    role: "system",
    authorId: "decision-panel",
    authorName: "决策面板",
    createdAt: nowIso(),
    kind: "decision",
    decision: {
      sourceMessageId: message.id,
      sourceAuthorName: message.authorName,
      title: detected.title,
      summary: detected.summary,
      question: detected.question,
      options: detected.options,
      allowCustom: detected.allowCustom,
      status: "pending",
    },
  };
}

function extractDecisionMarker(text: string): Omit<DecisionMessage["decision"], "sourceMessageId" | "sourceAuthorName" | "status" | "selectedOptionId" | "customResponse"> | null {
  const jsonMatch = text.match(/<!--\s*sl-decision\s*([\s\S]*?)\s*-->/);
  const base64Match = text.match(/<!--\s*sl-decision:([A-Za-z0-9+/=]+)\s*-->/);
  if (!jsonMatch && !base64Match) return null;
  try {
    const raw = base64Match
      ? decodeURIComponent(escape(atob(base64Match[1])))
      : jsonMatch?.[1]?.trim() ?? "";
    const parsed = JSON.parse(raw) as Partial<DecisionMessage["decision"]>;
    const options = normalizeDecisionOptions(parsed.options ?? []);
    if (!parsed.question || options.length < 1) return null;
    return {
      title: parsed.title || "需要你决策",
      summary: parsed.summary || "Agent 需要你确认下一步。",
      question: parsed.question,
      options,
      allowCustom: parsed.allowCustom ?? true,
    };
  } catch {
    return null;
  }
}

function inferDecisionFromText(text: string): Omit<DecisionMessage["decision"], "sourceMessageId" | "sourceAuthorName" | "status" | "selectedOptionId" | "customResponse"> | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const decisionIntent = /(请选择|你选择|请确认|需要你决定|需要你确认|是否|要不要|哪一种|哪一个|哪个|哪个方案|下一步|你来判断|你决定|你帮我选|让我选)/;
  if (!decisionIntent.test(text)) {
    return null;
  }
  const options = normalizeDecisionOptions(lines.flatMap((line, index) => {
    if (line.startsWith("|") || line.startsWith("```")) return [];
    const numbered = line.match(/^(?:[-*]\s*)?(?:方案|选项)?\s*([A-Da-d]|\d{1,2})[.、)：:]\s*(.+)$/);
    if (numbered) {
      return [{
        id: fieldId(numbered[1], index),
        label: cleanOptionLabel(numbered[2]),
        value: numbered[2].trim(),
      }];
    }
    return [];
  }));

  if (options.length < 2) return null;
  const question = [...lines].reverse().find((line) => decisionIntent.test(line)) ?? "请选择下一步处理方式。";
  return {
    title: "需要你决策",
    summary: "Agent 已整理出可选项，选择后会继续当前任务。",
    question,
    options: options.slice(0, 6),
    allowCustom: true,
  };
}

function normalizeDecisionOptions(options: unknown[]): DecisionOption[] {
  return options
    .map((raw, index): DecisionOption | null => {
      if (typeof raw === "string") {
        const label = cleanOptionLabel(raw);
        return { id: `option-${index + 1}`, label, value: raw };
      }
      if (!raw || typeof raw !== "object") return null;
      const item = raw as Partial<DecisionOption>;
      const label = cleanOptionLabel(String(item.label ?? item.value ?? `选项 ${index + 1}`));
      return {
        id: String(item.id ?? fieldId(label, index)),
        label,
        value: String(item.value ?? item.label ?? label),
        description: item.description ? String(item.description) : undefined,
      };
    })
    .filter((option): option is DecisionOption => Boolean(option?.label && option.value));
}

function cleanOptionLabel(value: string): string {
  return value
    .replace(/^\s*(?:[-*]\s*)?(?:方案|选项)?\s*([A-Da-d]|\d{1,2})[.、)：:]\s*/, "")
    .replace(/\*\*/g, "")
    .trim()
    .slice(0, 48);
}

function stripDecisionMarker(text: string): string {
  return text.replace(/<!--\s*sl-decision[\s\S]*?-->/g, "").trim();
}

function fieldId(label: string, index: number): string {
  const normalized = label
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || `option-${index + 1}`;
}

function withDecisionPanels(messages: Message[]): Message[] {
  const existingIds = new Set(messages.map((message) => message.id));
  const next: Message[] = [];
  for (const message of messages) {
    next.push(message);
    if (message.kind !== "text" || message.role !== "agent" || message.streaming) continue;
    const decision = analyzeDecisionMessage(message);
    if (!decision || existingIds.has(decision.id)) continue;
    existingIds.add(decision.id);
    next.push(decision);
    void persistDecision(decision);
  }
  return next;
}

export const useStore = create<State>((set, get) => ({
  agents: [],
  conversations: [],
  messagesByConversation: {},
  loadedConversations: new Set<string>(),
  typingByConversation: {},
  tasks: [],
  toolLogs: [],
  scheduledTasks: [],
  skills: [],
  connection: "closed",
  ready: false,

  bootstrap: async () => {
    try {
      const [agents, conversations, tasks, toolLogs, scheduledTasks, skills] = await Promise.all([
        fetchAgents(),
        fetchConversations(),
        fetchTasks(),
        fetchToolLogs(),
        fetchScheduledTasks(),
        fetchSkills(),
      ]);
      set({ agents, conversations, tasks, toolLogs, scheduledTasks, skills, ready: true });
    } catch (err) {
      console.error("bootstrap failed", err);
    }

    streamClient.subscribe((event) => get().applyEvent(event));
    streamClient.onState((state) => get().setConnection(state));
    streamClient.connect();
  },

  createGroupConversation: async (title, botIds, icon = "users") => {
    const conversation = await createConversation({ title, kind: "group", botIds, icon });
    set((s) => ({
      conversations: [conversation, ...s.conversations.filter((c) => c.id !== conversation.id)],
    }));
    return conversation.id;
  },

  createPrivateSession: async (botId) => {
    const agent = get().agents.find((a) => a.id === botId);
    const conversation = await createConversation({
      title: agent ? `${agent.name} · ${timeLabel()} 任务` : `新私聊任务 · ${timeLabel()}`,
      kind: "private",
      botIds: [botId],
    });
    set((s) => ({
      conversations: [conversation, ...s.conversations.filter((c) => c.id !== conversation.id)],
    }));
    return conversation.id;
  },

  renameTask: async (chatId, title) => {
    const conversation = await renameConversation(chatId, title);
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === chatId ? conversation : c,
      ),
    }));
  },

  updateTaskIcon: async (chatId, icon) => {
    const conversation = await updateConversationIcon(chatId, icon);
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === chatId ? conversation : c,
      ),
    }));
  },

  archiveTask: async (chatId) => {
    await archiveConversation(chatId);
    set((s) => ({
      conversations: s.conversations.filter((c) => c.id !== chatId),
    }));
  },

  deleteTask: async (chatId) => {
    await deleteConversation(chatId);
    set((s) => {
      const { [chatId]: _messages, ...messagesByConversation } = s.messagesByConversation;
      const { [chatId]: _typing, ...typingByConversation } = s.typingByConversation;
      const loadedConversations = new Set(s.loadedConversations);
      loadedConversations.delete(chatId);
      return {
        conversations: s.conversations.filter((c) => c.id !== chatId),
        messagesByConversation,
        typingByConversation,
        loadedConversations,
      };
    });
  },

  deleteScheduledTask: async (id) => {
    await deleteScheduledTask(id);
    set((s) => ({
      scheduledTasks: s.scheduledTasks.filter((task) => task.id !== id),
    }));
  },

  refreshScheduledTasks: async () => {
    const scheduledTasks = await fetchScheduledTasks();
    set({ scheduledTasks });
  },

  ensureMessages: async (chatId) => {
    if (get().loadedConversations.has(chatId)) return;
    const conv = get().conversations.find((c) => c.id === chatId);
    if (!conv) return;
    const botId = conv.botId;
    if (!botId) return;
    try {
      const messages = await fetchMessages(botId, chatId);
      const messagesWithPanels = withDecisionPanels(messages);
      set((s) => ({
        messagesByConversation: {
          ...s.messagesByConversation,
          [chatId]: messagesWithPanels,
        },
        loadedConversations: new Set(s.loadedConversations).add(chatId),
      }));
    } catch (err) {
      console.warn(`load messages failed for ${chatId}`, err);
      set((s) => ({
        loadedConversations: new Set(s.loadedConversations).add(chatId),
      }));
    }
  },

  sendMessage: async (chatId, text) => {
    const conv = get().conversations.find((c) => c.id === chatId);
    if (!conv) return;
    const botId = conv.botId;
    if (!botId) return;
    const { botIds: targetBotIds, routeMode } = messageTargets(text, conv, get().agents);

    const userMsgId = clientId();
    const userMsg: TextMessage = {
      id: userMsgId,
      conversationId: chatId,
      role: "user",
      authorId: "me",
      authorName: "Me",
      createdAt: nowIso(),
      kind: "text",
      content: text,
      status: "pending",
    };
    set((s) => ({
      messagesByConversation: {
        ...s.messagesByConversation,
        [chatId]: [...(s.messagesByConversation[chatId] ?? []), userMsg],
      },
    }));

    try {
      const { messageId, messageIds, scheduledTask } = await postMessage(botId, chatId, text, targetBotIds, routeMode);
      set((s) => {
        const arr = (s.messagesByConversation[chatId] ?? []).map((m): Message =>
          m.id === userMsgId && m.kind === "text"
            ? { ...m, status: "sent" }
            : m,
        );
        const targets = messageIds?.length
          ? messageIds
          : [{ botId, messageId }];
        const placeholders: TextMessage[] = targets.map((target) => ({
          id: target.messageId,
          conversationId: chatId,
          role: "agent",
          authorId: target.botId,
          authorName:
            s.agents.find((a) => a.id === target.botId)?.name ?? target.botId,
          createdAt: nowIso(),
          kind: "text",
          content: "",
          streaming: true,
        }));
        return {
          messagesByConversation: {
            ...s.messagesByConversation,
            [chatId]: [...arr, ...placeholders],
          },
          scheduledTasks: scheduledTask
            ? [scheduledTask, ...s.scheduledTasks.filter((task) => task.id !== scheduledTask.id)]
            : s.scheduledTasks,
        };
      });
    } catch (err) {
      console.error("send failed", err);
      set((s) => ({
        messagesByConversation: {
          ...s.messagesByConversation,
          [chatId]: (s.messagesByConversation[chatId] ?? []).map((m): Message =>
            m.id === userMsgId && m.kind === "text"
              ? { ...m, status: "failed", errorMessage: String(err) }
              : m,
          ),
        },
      }));
    }
  },

  addSkillRunForm: async (chatId, skill) => {
    const conv = get().conversations.find((c) => c.id === chatId);
    if (!conv || conv.kind !== "private") return;
    const agent = get().agents.find((a) => a.id === conv.botId);
    const formId = clientId();
    const formMessage: SkillFormMessage = {
      id: formId,
      conversationId: chatId,
      role: "system",
      authorId: "skill-form",
      authorName: "Skill 参数",
      createdAt: nowIso(),
      kind: "skill-form",
      skillForm: {
        skill,
        agentId: conv.botId,
        agentName: agent?.name ?? conv.botId,
        analysisSummary: "正在交给当前 Agent 分析该 skill 需要哪些参数…",
        fields: [],
        status: "analyzing",
      },
    };
    set((s) => ({
      messagesByConversation: {
        ...s.messagesByConversation,
        [chatId]: [
          ...(s.messagesByConversation[chatId] ?? []),
          formMessage,
        ],
      },
    }));
    void persistSkillForm(formMessage);
    try {
      const analysis = await analyzeSkill({ botId: conv.botId, skillId: skill.id });
      let nextFormMessage: SkillFormMessage | undefined;
      set((s) => ({
        messagesByConversation: {
          ...s.messagesByConversation,
          [chatId]: (s.messagesByConversation[chatId] ?? []).map((message): Message =>
            message.id === formId && message.kind === "skill-form"
              ? (nextFormMessage = {
                  ...message,
                  skillForm: {
                    ...message.skillForm,
                    skill: analysis.skill,
                    agentId: analysis.agentId,
                    agentName: analysis.agentName,
                    analysisSummary: analysis.analysisSummary,
                    fields: analysis.fields,
                    status: "pending",
                  },
                })
              : message,
          ),
        },
      }));
      if (nextFormMessage) void persistSkillForm(nextFormMessage);
    } catch (err) {
      let nextFormMessage: SkillFormMessage | undefined;
      set((s) => ({
        messagesByConversation: {
          ...s.messagesByConversation,
          [chatId]: (s.messagesByConversation[chatId] ?? []).map((message): Message =>
            message.id === formId && message.kind === "skill-form"
              ? (nextFormMessage = {
                  ...message,
                  skillForm: {
                    ...message.skillForm,
                    analysisSummary: "Agent 分析 skill 参数失败，请稍后重试。",
                    fields: [],
                    status: "failed",
                    errorMessage: String(err),
                  },
                })
              : message,
          ),
        },
      }));
      if (nextFormMessage) void persistSkillForm(nextFormMessage);
    }
  },

  submitSkillRunForm: async (chatId, formMessageId, values) => {
    const formMessage = (get().messagesByConversation[chatId] ?? [])
      .find((message) => message.id === formMessageId && message.kind === "skill-form");
    if (!formMessage || formMessage.kind !== "skill-form") return;
    const conv = get().conversations.find((c) => c.id === chatId);
    if (!conv) return;
    const botId = conv.botId;
    let submittingMessage: SkillFormMessage | undefined;
    set((s) => ({
      messagesByConversation: {
        ...s.messagesByConversation,
        [chatId]: (s.messagesByConversation[chatId] ?? []).map((message): Message =>
          message.id === formMessageId && message.kind === "skill-form"
            ? (submittingMessage = { ...message, skillForm: { ...message.skillForm, status: "submitting", values, errorMessage: undefined } })
            : message,
        ),
      },
    }));
    if (submittingMessage) void persistSkillForm(submittingMessage);
    const prompt = buildSkillExecutionPrompt(
      formMessage.skillForm.skill,
      chatId,
      formMessage.skillForm.fields,
      values,
    );
    try {
      const { messageId, messageIds, scheduledTask } = await postMessage(
        botId,
        chatId,
        prompt,
        [botId],
        "default",
        true,
      );
      let submittedMessage: SkillFormMessage | undefined;
      set((s) => ({
        messagesByConversation: {
          ...s.messagesByConversation,
          [chatId]: [
            ...(s.messagesByConversation[chatId] ?? []).map((message): Message =>
            message.id === formMessageId && message.kind === "skill-form"
              ? (submittedMessage = { ...message, skillForm: { ...message.skillForm, status: "submitted", values } })
              : message,
            ),
            ...(messageIds?.length ? messageIds : [{ botId, messageId }]).map((target): TextMessage => ({
              id: target.messageId,
              conversationId: chatId,
              role: "agent",
              authorId: target.botId,
              authorName: s.agents.find((a) => a.id === target.botId)?.name ?? target.botId,
              createdAt: nowIso(),
              kind: "text",
              content: "",
              streaming: true,
            })),
          ],
        },
        scheduledTasks: scheduledTask
          ? [scheduledTask, ...s.scheduledTasks.filter((task) => task.id !== scheduledTask.id)]
          : s.scheduledTasks,
      }));
      if (submittedMessage) void persistSkillForm(submittedMessage);
    } catch (err) {
      let failedSubmitMessage: SkillFormMessage | undefined;
      set((s) => ({
        messagesByConversation: {
          ...s.messagesByConversation,
          [chatId]: (s.messagesByConversation[chatId] ?? []).map((message): Message =>
            message.id === formMessageId && message.kind === "skill-form"
              ? (failedSubmitMessage = { ...message, skillForm: { ...message.skillForm, status: "pending", values, errorMessage: String(err) } })
              : message,
          ),
        },
      }));
      if (failedSubmitMessage) void persistSkillForm(failedSubmitMessage);
    }
  },

  cancelSkillRunForm: (chatId, formMessageId, values) => {
    let cancelledMessage: SkillFormMessage | undefined;
    set((s) => ({
      messagesByConversation: {
        ...s.messagesByConversation,
        [chatId]: (s.messagesByConversation[chatId] ?? []).map((message): Message =>
          message.id === formMessageId && message.kind === "skill-form"
            ? (cancelledMessage = {
                ...message,
                skillForm: {
                  ...message.skillForm,
                  status: "cancelled",
                  values: values ?? message.skillForm.values,
                  errorMessage: undefined,
                },
              })
            : message,
        ),
      },
    }));
    if (cancelledMessage) void persistSkillForm(cancelledMessage);
  },

  submitDecision: async (chatId, decisionMessageId, optionId, customResponse) => {
    const current = (get().messagesByConversation[chatId] ?? [])
      .find((message) => message.id === decisionMessageId && message.kind === "decision");
    if (!current || current.kind !== "decision" || current.decision.status !== "pending") return;

    const selected = current.decision.options.find((option) => option.id === optionId);
    const text = customResponse?.trim()
      ? `我的选择：${customResponse.trim()}`
      : selected
        ? `我的选择：${selected.label}\n\n${selected.value}`
        : "";
    if (!text) return;

    let submittedDecision: DecisionMessage | undefined;
    set((s) => ({
      messagesByConversation: {
        ...s.messagesByConversation,
        [chatId]: (s.messagesByConversation[chatId] ?? []).map((message): Message =>
          message.id === decisionMessageId && message.kind === "decision"
            ? (submittedDecision = {
                ...message,
                decision: {
                  ...message.decision,
                  status: "submitted",
                  selectedOptionId: customResponse?.trim() ? undefined : selected?.id,
                  customResponse: customResponse?.trim() || undefined,
                },
              })
            : message,
        ),
      },
    }));
    if (submittedDecision) void persistDecision(submittedDecision);
    await get().sendMessage(chatId, text);
  },

  submitDecisionBatch: async (chatId, decisions) => {
    const decisionMap = new Map(decisions.map((decision) => [decision.decisionMessageId, decision]));
    const current = (get().messagesByConversation[chatId] ?? [])
      .filter((message): message is DecisionMessage =>
        message.kind === "decision" && message.decision.status === "pending" && decisionMap.has(message.id),
      );
    if (current.length === 0) return;

    const submitted: DecisionMessage[] = [];
    const responseParts = current.flatMap((message, index) => {
      const input = decisionMap.get(message.id);
      if (!input) return [];
      const custom = input.customResponse?.trim();
      const selected = message.decision.options.find((option) => option.id === input.optionId);
      if (!custom && !selected) return [];
      const answer = custom || selected?.label || "";
      const value = custom ? "" : selected?.value || "";
      return [
        [
          `${index + 1}. ${message.decision.question}`,
          `选择：${answer}`,
          value && value !== answer ? value : "",
        ].filter(Boolean).join("\n"),
      ];
    });
    if (responseParts.length !== current.length) return;

    set((s) => ({
      messagesByConversation: {
        ...s.messagesByConversation,
        [chatId]: (s.messagesByConversation[chatId] ?? []).map((message): Message => {
          if (message.kind !== "decision") return message;
          const input = decisionMap.get(message.id);
          if (!input || message.decision.status !== "pending") return message;
          const selected = message.decision.options.find((option) => option.id === input.optionId);
          const next: DecisionMessage = {
            ...message,
            decision: {
              ...message.decision,
              status: "submitted",
              selectedOptionId: input.customResponse?.trim() ? undefined : selected?.id,
              customResponse: input.customResponse?.trim() || undefined,
            },
          };
          submitted.push(next);
          return next;
        }),
      },
    }));
    submitted.forEach((message) => void persistDecision(message));
    await get().sendMessage(chatId, `我的批量决策：\n\n${responseParts.join("\n\n")}`);
  },

  cancelDecision: (chatId, decisionMessageId) => {
    let cancelledDecision: DecisionMessage | undefined;
    set((s) => ({
      messagesByConversation: {
        ...s.messagesByConversation,
        [chatId]: (s.messagesByConversation[chatId] ?? []).map((message): Message =>
          message.id === decisionMessageId && message.kind === "decision"
            ? (cancelledDecision = {
                ...message,
                decision: {
                  ...message.decision,
                  status: "cancelled",
                },
              })
            : message,
        ),
      },
    }));
    if (cancelledDecision) void persistDecision(cancelledDecision);
  },

  applyEvent: (event) => {
    if (event.type === "agent_status") {
      set((s) => ({
        agents: s.agents.map((a) =>
          a.id === event.botId ? { ...a, status: statusFromString(event.status) } : a,
        ),
      }));
      return;
    }
    if (event.type === "typing") {
      set((s) => {
        const list = s.typingByConversation[event.chatId] ?? [];
        const next = event.on
          ? Array.from(new Set([...list, event.botId]))
          : list.filter((b) => b !== event.botId);
        return {
          typingByConversation: {
            ...s.typingByConversation,
            [event.chatId]: next,
          },
        };
      });
      return;
    }

    if (event.type === "chunk" || event.type === "done") {
      const { chatId, messageId, botId } = event;
      let decisionToPersist: DecisionMessage | undefined;
      set((s) => {
        const existing = s.messagesByConversation[chatId] ?? [];
        let foundIdx = -1;
        for (let i = existing.length - 1; i >= 0; i--) {
          const m = existing[i];
          if (m.id === messageId) {
            foundIdx = i;
            break;
          }
        }
        let nextArr: Message[];
        if (foundIdx === -1) {
          const content = event.type === "chunk" ? event.chunk : stripDecisionMarker(event.fullText);
          // Bot replied without a matching placeholder (e.g., delegation chain or
          // bot replying to a Feishu-originated message we're observing). Append
          // a fresh agent bubble so it shows up in real time.
          const newMsg: TextMessage = {
            id: messageId,
            conversationId: chatId,
            role: "agent",
            authorId: botId,
            authorName: s.agents.find((a) => a.id === botId)?.name ?? botId,
            createdAt: nowIso(),
            kind: "text",
            content,
            streaming: event.type === "chunk",
          };
          nextArr = [...existing, newMsg];
          if (event.type === "done") {
            const decision = analyzeDecisionMessage(newMsg);
            if (decision && !nextArr.some((message) => message.id === decision.id)) {
              decisionToPersist = decision;
              nextArr = [...nextArr, decision];
            }
          }
        } else {
          nextArr = existing.slice();
          const target = nextArr[foundIdx];
          if (target.kind === "text") {
            if (event.type === "chunk") {
              nextArr[foundIdx] = {
                ...target,
                content: target.content + event.chunk,
              };
            } else {
              const content = stripDecisionMarker(event.fullText || target.content);
              const doneMessage: TextMessage = {
                ...target,
                content,
                streaming: false,
              };
              nextArr[foundIdx] = {
                ...doneMessage,
              };
              const decision = analyzeDecisionMessage(doneMessage);
              if (decision && !nextArr.some((message) => message.id === decision.id)) {
                decisionToPersist = decision;
                nextArr = [
                  ...nextArr.slice(0, foundIdx + 1),
                  decision,
                  ...nextArr.slice(foundIdx + 1),
                ];
              }
            }
          }
        }
        return {
          messagesByConversation: {
            ...s.messagesByConversation,
            [chatId]: nextArr,
          },
        };
      });
      if (decisionToPersist) void persistDecision(decisionToPersist);
    }
  },

  setConnection: (state) => set({ connection: state }),
}));
