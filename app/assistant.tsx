"use client";

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useStreamRuntime } from "@assistant-ui/react-langchain";
import { MessageSquareShareIcon } from "lucide-react";

import { Thread } from "@/components/assistant-ui/thread";
import { ThreadList } from "@/components/assistant-ui/thread-list";
import { Button } from "@/components/ui/button";
import { threadListAdapter } from "@/lib/threads/adapter";

export function Assistant() {
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
      <div className="flex h-dvh flex-col">
        <header className="flex items-center justify-between border-b px-4 py-2">
          <span className="text-sm font-semibold">assistant-ui</span>
          <Button variant="ghost" size="icon" aria-label="Share">
            <MessageSquareShareIcon className="size-4" />
          </Button>
        </header>
        <div className="flex min-h-0 flex-1">
          <aside className="w-64 shrink-0 border-r">
            <ThreadList />
          </aside>
          <main className="flex-1 min-w-0">
            <Thread />
          </main>
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}
