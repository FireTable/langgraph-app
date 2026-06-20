"use client";

import { useState } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useStreamRuntime } from "@assistant-ui/react-langchain";
import { useAuiState } from "@assistant-ui/react";
import { PanelLeftIcon, ShareIcon } from "lucide-react";

import { Thread } from "@/components/assistant-ui/thread";
import { ThreadList } from "@/components/assistant-ui/thread-list";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { threadListAdapter } from "@/lib/threads/adapter";
import { cn } from "@/lib/utils";

// Sidebar — collapsible, hosts the ThreadList.
// Width collapses from 260px to 0; the toggle button stays in the header.
function Sidebar({ collapsed }: { collapsed: boolean }) {
  return (
    <aside
      className={cn(
        "hidden shrink-0 border-r transition-[width] duration-200 md:block",
        collapsed ? "w-0 overflow-hidden" : "w-64",
      )}
    >
      <ThreadList />
    </aside>
  );
}

// Header sits INSIDE the chat card (matches the official layout).
// Shows the sidebar toggle, the active thread's title, and a share button.
function Header({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const title = useAuiState(
    (s) => s.threads.threadItems.find((t) => t.id === s.threads.mainThreadId)?.title,
  );
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 px-4">
      <TooltipIconButton
        variant="ghost"
        size="icon"
        tooltip={collapsed ? "Show sidebar" : "Hide sidebar"}
        side="bottom"
        onClick={onToggle}
        className="size-8"
      >
        <PanelLeftIcon className="size-4" />
      </TooltipIconButton>
      <span className="min-w-0 truncate text-sm font-medium">{title ?? "New Chat"}</span>
      <TooltipIconButton
        variant="ghost"
        size="icon"
        tooltip="Share"
        side="bottom"
        className="ml-auto size-8"
      >
        <ShareIcon className="size-4" />
      </TooltipIconButton>
    </header>
  );
}

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
      {/* Outer: gutter + padding. bg-muted/30 shows behind the card. */}
      <div className="bg-muted/30 flex h-dvh w-full">
        <Sidebar collapsed={sidebarCollapsed} />
        {/* Right column: padding lets the card float above the gutter. */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden p-2 md:pl-0">
          {/* The card — every visible chat element lives inside. */}
          <div className="bg-background flex flex-1 flex-col overflow-hidden rounded-lg border">
            <Header
              collapsed={sidebarCollapsed}
              onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
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
