"use client";

import { useEffect, useMemo, useRef, useState, type FC } from "react";
import { AssistantRuntimeProvider, useAui, useAuiState } from "@assistant-ui/react";
import { unstable_createLangGraphStream, useLangGraphRuntime } from "@assistant-ui/react-langgraph";
import { Client } from "@langchain/langgraph-sdk";
import { ThreadListPrimitive } from "@assistant-ui/react";
import { MenuIcon, MessageSquareTextIcon, PanelLeftIcon, PlusIcon, ShareIcon } from "lucide-react";

import { Thread } from "@/components/assistant-ui/thread";
import { ThreadList } from "@/components/assistant-ui/thread-list";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { threadListAdapter } from "@/lib/threads/adapter";
import { cn } from "@/lib/utils";
import { LOCAL_THREAD_PREFIX, ACTIVE_THREAD_ID } from "@/lib/constants";

const Logo: FC = () => {
  return (
    <div className="flex items-center gap-2 px-2 text-sm font-medium">
      <MessageSquareTextIcon className="text-foreground/90 size-5" />
      <span className="text-foreground/90">assistant-ui</span>
    </div>
  );
};

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

  // Default to the in-app /api proxy so CORS + x-api-key stay in Next.js;
  // NEXT_PUBLIC_LANGGRAPH_API_URL bypasses it (e.g. behind Cloudflare Tunnel).
  const apiUrl =
    process.env.NEXT_PUBLIC_LANGGRAPH_API_URL ||
    (typeof window !== "undefined" ? new URL("/api", window.location.href).href : undefined);

  const assistantId = process.env.NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID!;

  // apiUrl is undefined on the first SSR pass, so the runtime builds lazily.
  const client = useMemo(() => new Client({ apiUrl: apiUrl! }), [apiUrl]);

  const stream = useMemo(
    () => unstable_createLangGraphStream({ client, assistantId }),
    [client, assistantId],
  );

  const runtime = useLangGraphRuntime({
    unstable_threadListAdapter: threadListAdapter,
    stream,
    create: async () => {
      const { externalId } = await threadListAdapter.initialize!("local");
      return { externalId: externalId! };
    },
    // Empty messages on a fresh thread — state.values has no `messages` key yet.
    load: async (externalId) => {
      const state = await client.threads.getState(externalId);
      const values = state.values as { messages?: unknown };
      return { messages: (values.messages ?? []) as never };
    },
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



// Persists the active thread id to localStorage so the chat reopens on the
// same thread after a refresh. We write the runtime's externalId (our
// Postgres uuid) rather than mainThreadId, because the runtime keeps
// _mainThreadId on the placeholder __LOCALID_* until the user
// explicitly switches threads — see assistant-ui #2577 and PR #3855
// for the related ExternalStore fix; RemoteThreadList is still affected.
const ThreadPersistence: FC = () => {
  const api = useAui();
  const mainThreadId = useAuiState((s) => s.threads.mainThreadId);
  const activeExternalId = useAuiState((s) =>
    s.threads.threadItems.find((t) => t.id === s.threads.mainThreadId)?.externalId,
  );
  const hasHydratedRef = useRef(false);

  // Runs before the write effect on first commit so hasHydratedRef
  // suppresses the placeholder write below.
  useEffect(() => {
    const savedId = localStorage.getItem(ACTIVE_THREAD_ID);
    if (savedId) {
      // switchToThread is typed void but returns a Promise at runtime.
      void Promise.resolve(api.threads().switchToThread(savedId) as unknown as Promise<void>).catch(
        () => {
          localStorage.removeItem(ACTIVE_THREAD_ID);
        },
      );
    }
    hasHydratedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hasHydratedRef.current) return;
    const id = activeExternalId ?? mainThreadId;
    if (!id || id.startsWith(LOCAL_THREAD_PREFIX)) {
      localStorage.removeItem(ACTIVE_THREAD_ID);
      return;
    }
    localStorage.setItem(ACTIVE_THREAD_ID, id);
  }, [activeExternalId, mainThreadId]);

  return null;
};
