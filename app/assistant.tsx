"use client";

import { useEffect, useRef, useState, type FC } from "react";
import { AssistantRuntimeProvider, useAui, useAuiState } from "@assistant-ui/react";
import { useStreamRuntime } from "@assistant-ui/react-langchain";
import { ThreadListPrimitive } from "@assistant-ui/react";
import { MenuIcon, MessageSquareTextIcon, PanelLeftIcon, PlusIcon, ShareIcon } from "lucide-react";

import { Thread } from "@/components/assistant-ui/thread";
import { ThreadList } from "@/components/assistant-ui/thread-list";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { threadListAdapter } from "@/lib/threads/adapter";
import { cn } from "@/lib/utils";

// Brand mark used in both desktop and mobile sidebar headers.
const Logo: FC = () => {
  return (
    <div className="flex items-center gap-2 px-2 text-sm font-medium">
      <MessageSquareTextIcon className="text-foreground/90 size-5" />
      <span className="text-foreground/90">assistant-ui</span>
    </div>
  );
};

// Desktop sidebar — collapses between w-12 (just a + button) and w-65
// (logo + full ThreadList). Matches the official example structure.
const Sidebar: FC<{ collapsed?: boolean }> = ({ collapsed }) => {
  return (
    <aside
      className={cn(
        "hidden h-full flex-col overflow-hidden transition-all duration-200 md:flex",
        collapsed ? "w-12" : "w-65",
      )}
    >
      <div
        className={cn(
          "mt-2 flex h-12 shrink-0 items-center transition-[padding] duration-200",
          collapsed ? "px-3.5" : "px-6",
        )}
      >
        <MessageSquareTextIcon className="text-foreground/90 size-5 shrink-0" />
        <span
          className={cn(
            "text-foreground/90 ml-2 text-sm font-medium whitespace-nowrap transition-opacity duration-200",
            collapsed && "opacity-0",
          )}
        >
          assistant-ui
        </span>
      </div>
      {collapsed ? (
        <ThreadListPrimitive.New asChild>
          <TooltipIconButton
            tooltip="New thread"
            side="right"
            variant="ghost"
            size="icon"
            className="mt-1 ml-2 size-8"
          >
            <PlusIcon className="size-4" />
          </TooltipIconButton>
        </ThreadListPrimitive.New>
      ) : (
        <div className="relative w-65 flex-1 overflow-y-auto p-3">
          <ThreadList />
        </div>
      )}
    </aside>
  );
};

// Mobile sidebar uses a Sheet that slides in from the left.
const MobileSidebar: FC = () => {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8 shrink-0 md:hidden">
          <MenuIcon className="size-4" />
          <span className="sr-only">Toggle menu</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="flex w-70 flex-col p-0">
        <div className="flex h-12 shrink-0 items-center px-4">
          <Logo />
        </div>
        <div className="relative flex-1 overflow-y-auto p-3">
          <ThreadList />
        </div>
      </SheetContent>
    </Sheet>
  );
};

const ThreadTitle: FC = () => {
  const title = useAuiState(
    (s) => s.threads.threadItems.find((t) => t.id === s.threads.mainThreadId)?.title,
  );
  return <span className="min-w-0 truncate text-sm font-medium">{title ?? "New Chat"}</span>;
};

const Header: FC<{
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}> = ({ sidebarCollapsed, onToggleSidebar }) => {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 px-4">
      <MobileSidebar />
      <TooltipIconButton
        variant="ghost"
        size="icon"
        tooltip={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        side="bottom"
        onClick={onToggleSidebar}
        className="hidden size-8 md:flex"
      >
        <PanelLeftIcon className="size-4" />
      </TooltipIconButton>
      <ThreadTitle />
      <TooltipIconButton
        variant="ghost"
        size="icon"
        tooltip="Share"
        side="bottom"
        disabled
        className="ml-auto size-8"
      >
        <ShareIcon className="size-4" />
      </TooltipIconButton>
    </header>
  );
};

export function Assistant() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const apiUrl =
    process.env.NEXT_PUBLIC_LANGGRAPH_API_URL ||
    (typeof window !== "undefined" ? new URL("/api", window.location.href).href : undefined);

  const runtime = useStreamRuntime({
    assistantId: process.env.NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID!,
    apiUrl,
    unstable_threadListAdapter: threadListAdapter,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPersistence />
      <div className="bg-muted/30 flex h-dvh w-full">
        <Sidebar collapsed={sidebarCollapsed} />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden p-2 md:pl-0">
          <div className="bg-background flex flex-1 flex-col overflow-hidden rounded-lg border">
            <Header
              sidebarCollapsed={sidebarCollapsed}
              onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
            />
            <main className="flex-1 overflow-hidden">
              <Thread />
            </main>
          </div>
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}

// Placeholder mainThreadId assigned to a freshly-created "new thread" that
// hasn't been persisted yet. Filter it out before writing to localStorage —
// we don't want to "remember" a thread id that has no backing record on
// the server, otherwise the next page load would try to switchToThread a
// ghost and hit 404.
const LOCAL_THREAD_PREFIX = "__LOCALID_";
const ACTIVE_THREAD_KEY = "active-thread-id";

/**
 * Persist the active thread id to localStorage so the chat reopens on the
 * same thread after a refresh.
 *
 * - On mount, if a saved id exists, switchToThread restores it. If the
 *   thread has been deleted server-side, switchToThread rejects and we
 *   clear the stale entry.
 * - On every subsequent `mainThreadId` change we write the new id. The
 *   initial `__LOCALID_…` placeholder from the runtime constructor is
 *   skipped via `hasHydratedRef`, so we don't wipe the entry we're about
 *   to restore from.
 *
 * Uses the imperative `useAui().threads()` API rather than touching the
 * sidebar click handlers, so the runtime's internal thread-state cache
 * and `switchToThread` no-op path keep working unchanged.
 */
const ThreadPersistence: FC = () => {
  const api = useAui();
  const mainThreadId = useAuiState((s) => s.threads.mainThreadId);
  const hasHydratedRef = useRef(false);

  // Restore once on mount. Runs before the write effect below for this
  // first commit, so the write effect's `hasHydratedRef` check correctly
  // suppresses the placeholder write.
  useEffect(() => {
    const savedId = localStorage.getItem(ACTIVE_THREAD_KEY);
    if (savedId) {
      // `switchToThread` is typed `void` by the legacy adapter even though
      // it actually returns a Promise at runtime, so we cast through
      // `unknown` to attach a `.catch` for the stale-id case.
      void Promise.resolve(api.threads().switchToThread(savedId) as unknown as Promise<void>).catch(
        () => {
          localStorage.removeItem(ACTIVE_THREAD_KEY);
        },
      );
    }
    hasHydratedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist on every mainThreadId transition after the initial restore.
  useEffect(() => {
    if (!hasHydratedRef.current) return;
    if (!mainThreadId || mainThreadId.startsWith(LOCAL_THREAD_PREFIX)) {
      localStorage.removeItem(ACTIVE_THREAD_KEY);
      return;
    }
    localStorage.setItem(ACTIVE_THREAD_KEY, mainThreadId);
  }, [mainThreadId]);

  return null;
};
