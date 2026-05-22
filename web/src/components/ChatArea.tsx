import { useEffect, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import { useStore } from "@/store";
import { MessageBubble } from "./MessageBubble";
import { Composer } from "./Composer";
import { Avatar } from "./Avatar";
import { GroupIcon } from "./GroupIcon";
import { StatusDot } from "./StatusDot";
import type { Agent, Message, SkillDefinition, TextMessage } from "@/data/types";

const EMPTY_MESSAGES: Message[] = [];
const EMPTY_TYPING_BOTS: string[] = [];
const BOTTOM_THRESHOLD_PX = 48;

export function ChatArea({ conversationId }: { conversationId: string }) {
  const conv = useStore((s) => s.conversations.find((c) => c.id === conversationId));
  const msgs = useStore((s) => s.messagesByConversation[conversationId] ?? EMPTY_MESSAGES);
  const agents = useStore((s) => s.agents);
  const ensureMessages = useStore((s) => s.ensureMessages);
  const typingBots = useStore(
    (s) => s.typingByConversation[conversationId] ?? EMPTY_TYPING_BOTS,
  );
  const [quotedMessage, setQuotedMessage] = useState<TextMessage | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldFollowBottomRef = useRef(true);

  useEffect(() => {
    if (conversationId) void ensureMessages(conversationId);
    setQuotedMessage(null);
    shouldFollowBottomRef.current = true;
  }, [conversationId, ensureMessages]);

  // Only follow new messages while the user is already at the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !shouldFollowBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [msgs]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldFollowBottomRef.current = distanceToBottom <= BOTTOM_THRESHOLD_PX;
  }

  if (!conv) return null;

  const memberAgents = conv.members
    .map((m) => agents.find((a) => a.id === m))
    .filter((a): a is NonNullable<typeof a> => Boolean(a));
  const privateAgent = conv.kind === "private"
    ? memberAgents[0] ?? agents.find((agent) => agent.id === conv.botId)
    : undefined;

  // Check if last message is streaming OR a bot is currently typing
  const lastMsg = msgs[msgs.length - 1];
  const isLastStreaming =
    lastMsg?.kind === "text" && (lastMsg as { streaming?: boolean }).streaming;
  const typingNames = typingBots
    .map((id) => agents.find((a) => a.id === id)?.name ?? id)
    .join(", ");

  return (
    <section className="flex-1 flex flex-col min-w-0 bg-bg">
      {/* Chat header */}
      <header className="h-14 border-b border-border px-5 flex items-center gap-3 shrink-0 overflow-hidden">
        {conv.kind === "group" ? (
          <GroupIcon value={conv.icon} size="sm" />
        ) : (
          <Avatar
            role={memberAgents[0]?.role ?? "user"}
            size="sm"
          />
        )}
        <div className="flex-1 min-w-0 overflow-hidden">
          <div className="text-sm font-medium truncate">{conv.title}</div>
          <div className="text-[11px] font-mono text-fg-muted truncate">
            {conv.kind === "group"
              ? `${memberAgents.length + 1} 成员 · ${memberAgents.map((a) => a.name).join(" · ")}`
              : memberAgents[0]?.description ?? ""}
          </div>
        </div>
        <div
          className="hidden lg:flex max-w-[38vw] shrink-0 items-center rounded-md border border-border bg-bg-deep px-2.5 py-1 font-mono text-[10px] leading-none text-fg-muted"
          title={conversationId}
        >
          <span className="mr-1.5 text-fg-subtle">ID</span>
          <span className="truncate">{conversationId}</span>
        </div>
        {conv.kind === "group" && (
          <div className="flex -space-x-1.5 shrink-0 max-w-[116px] overflow-hidden justify-end">
            {memberAgents.slice(0, 4).map((a) => (
              <div key={a.id} className="relative">
                <Avatar role={a.role} size="sm" />
                <StatusDot
                  status={a.status}
                  className="absolute -bottom-0.5 -right-0.5"
                />
              </div>
            ))}
          </div>
        )}
      </header>

      {/* Messages */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto py-5">
        {msgs.length === 0 ? (
          <EmptyHint kind={conv.kind} />
        ) : (
          msgs.map((m) => (
            <MessageBubble
              key={m.id}
              msg={m}
              onQuote={setQuotedMessage}
            />
          ))
        )}
      </div>

      {/* Typing indicator */}
      {(isLastStreaming || typingBots.length > 0) && (
        <div className="px-6 pb-1 text-[11px] font-mono text-accent-dim animate-pulse-soft">
          {typingNames || (lastMsg?.kind === "text" ? lastMsg.authorName : "")} 正在输入…
        </div>
      )}

      <Composer
        conversationId={conversationId}
        quotedMessage={quotedMessage}
        onClearQuote={() => setQuotedMessage(null)}
        mentionAgents={conv.kind === "group" ? memberAgents : []}
        skillOwner={conv.kind === "private" ? skillOwnerForAgent(privateAgent) : undefined}
        placeholder={
          conv.kind === "private"
            ? "输入任务内容…"
            : "输入消息,使用 @ 召唤特定 Agent…"
        }
      />
    </section>
  );
}

function skillOwnerForAgent(agent?: Agent): SkillDefinition["owner"] | undefined {
  const key = `${agent?.id ?? ""} ${agent?.name ?? ""}`;
  if (key.includes("运营经理")) return "运营经理";
  if (key.includes("KOL")) return "KOL增长";
  if (key.includes("SEO")) return "SEO内容";
  if (key.includes("社媒")) return "社媒分发";
  return undefined;
}

function EmptyHint({ kind }: { kind: "private" | "group" }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 text-fg-subtle">
      <MessageSquare size={40} className="opacity-30" />
      <p className="text-sm">{kind === "private" ? "任务还未开始" : "群聊任务还未开始"}</p>
      <span className="text-[11px] font-mono">
        {kind === "private" ? "输入目标或素材后发送给当前 Agent" : "输入 @ 选择成员并分派任务"}
      </span>
    </div>
  );
}
