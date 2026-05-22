import { useEffect, useState } from "react";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";
import { ChatArea } from "./components/ChatArea";
import { DetailsPanel } from "./components/DetailsPanel";
import { Dashboard } from "./components/Dashboard";
import { useBootstrap } from "./hooks/useBootstrap";
import { useStore } from "./store";

type AppView = "chat" | "dashboard";
type TaskTab = "private" | "group";

const STORAGE_KEYS = {
  view: "sl.view",
  taskTab: "sl.taskTab",
  activeConversation: "sl.activeConversation",
} as const;

export default function App() {
  useBootstrap();
  const conversations = useStore((s) => s.conversations);
  const ready = useStore((s) => s.ready);
  const [active, setActive] = useState<string>(() => readString(STORAGE_KEYS.activeConversation));
  const [taskTab, setTaskTab] = useState<TaskTab>(() => readTaskTab());
  const [view, setView] = useState<AppView>(() => readView());
  const activeConversation = conversations.find((c) => c.id === active);

  function selectConversation(id: string) {
    setActive(id);
    const conversation = conversations.find((c) => c.id === id);
    if (conversation) setTaskTab(conversation.kind);
  }

  useEffect(() => {
    writeString(STORAGE_KEYS.view, view);
  }, [view]);

  useEffect(() => {
    writeString(STORAGE_KEYS.taskTab, taskTab);
  }, [taskTab]);

  useEffect(() => {
    writeString(STORAGE_KEYS.activeConversation, active);
  }, [active]);

  useEffect(() => {
    if (!ready) return;
    if (conversations.length === 0) {
      setActive("");
      return;
    }

    const activeItem = conversations.find((c) => c.id === active);
    if (activeItem && activeItem.kind === taskTab) return;

    const nextInTab = conversations.find((c) => c.kind === taskTab);
    setActive(nextInTab?.id ?? "");
  }, [active, conversations, ready, taskTab]);

  function changeTaskTab(nextTab: TaskTab) {
    setTaskTab(nextTab);
    const next = conversations.find((c) => c.kind === nextTab);
    setActive(next?.id ?? "");
  }

  return (
    <div className="h-screen flex flex-col bg-bg text-fg app-shell">
      <TopBar view={view} onViewChange={setView} />
      {view === "dashboard" ? (
        <Dashboard
          onOpenConversation={(id) => {
            selectConversation(id);
            setView("chat");
          }}
        />
      ) : (
        <div className="flex-1 flex min-h-0">
          <Sidebar
            activeId={active}
            tab={taskTab}
            onTabChange={changeTaskTab}
            onSelect={selectConversation}
          />
          {activeConversation && ready ? (
            <ChatArea conversationId={active} />
          ) : (
            <EmptyWorkspace ready={ready} tab={taskTab} />
          )}
          <DetailsPanel onSelectConversation={selectConversation} />
        </div>
      )}
    </div>
  );
}

function readString(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeString(key: string, value: string) {
  try {
    if (value) {
      window.localStorage.setItem(key, value);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // localStorage can be unavailable in private or restricted contexts.
  }
}

function readTaskTab(): TaskTab {
  return readString(STORAGE_KEYS.taskTab) === "group" ? "group" : "private";
}

function readView(): AppView {
  return readString(STORAGE_KEYS.view) === "dashboard" ? "dashboard" : "chat";
}

function EmptyWorkspace({ ready, tab }: { ready: boolean; tab: TaskTab }) {
  return (
    <section className="flex-1 flex flex-col items-center justify-center gap-2 border-r border-border/40 text-center">
      <div className="text-sm font-medium text-fg-muted">
        {ready ? (tab === "group" ? "暂无群聊任务" : "暂无私聊任务") : "正在连接 SL 网关…"}
      </div>
      {ready && (
        <div className="text-[11px] font-mono text-fg-subtle">
          点击左侧 + 新建{tab === "group" ? "群聊" : "私聊"}任务
        </div>
      )}
    </section>
  );
}
