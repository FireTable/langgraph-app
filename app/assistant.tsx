"use client";

import { useEffect, useMemo, useRef, useState, type FC, type RefObject } from "react";
import {
  AssistantRuntimeProvider,
  Suggestions,
  Tools,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import { useLangGraphRuntime } from "@assistant-ui/react-langgraph";
import { Client } from "@langchain/langgraph-sdk";
import { ThreadListPrimitive } from "@assistant-ui/react";
import { Brain, MenuIcon, PanelLeftIcon, PlusIcon, ShareIcon } from "lucide-react";

import { BrandMark } from "@/components/brand-mark";

import { Thread } from "@/components/assistant-ui/thread";
import { ThreadList } from "@/components/assistant-ui/thread-list";
import { mergeSubgraphMessages } from "@/lib/langgraph/merge-subgraph-messages";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { UserButton } from "@/components/auth/user/user-button";
import { CreditUsageSlot } from "@/components/auth/user/credit-usage-slot";
import weatherToolkit from "@/components/tool-ui/toolkit";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { threadListAdapter } from "@/lib/threads/adapter";
import { R2AttachmentAdapter } from "@/lib/attachments/r2-adapter";
import { cn } from "@/lib/utils";
import { createLangGraphStream } from "@/lib/langgraph/create-stream";

// Provider-scoped values (api, mainThreadId) bridged into a ref so the
// runtime's eventHandlers can read them — they run before the provider
// mounts in the render tree.
type RuntimeBridge = {
  api: ReturnType<typeof useAui> | null;
  mainThreadId: string | null;
};

// ponytail: UserButton's `links` slot is the lowest-friction way to
// surface the Memory tab without rebuilding better-auth-ui's settings
// surface — and at the version installed here, `settingsTabs` has types
// but no render site. `MemoryView` lives at /settings/memory.
const memoryLink = [
  {
    label: "Memory",
    href: "/settings/memory",
    icon: <Brain className="text-muted-foreground" />,
    visibility: "authenticated" as const,
  },
];

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
        <BrandMark collapsed={collapsed} />
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
      <div className={cn("shrink-0 p-2", collapsed ? "flex justify-center" : "")}>
        {collapsed ? (
          <UserButton
            size="icon"
            className="border-border bg-card border"
            links={memoryLink}
            creditSlot={<CreditUsageSlot />}
          />
        ) : (
          <UserButton
            className="border-border bg-card w-full border"
            links={memoryLink}
            creditSlot={<CreditUsageSlot />}
          />
        )}
      </div>
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
          <BrandMark />
        </div>
        <div className="relative flex-1 overflow-y-auto p-3">
          <ThreadList />
        </div>
        <div className="shrink-0 p-2">
          <UserButton
            className="border-border bg-card w-full border"
            links={memoryLink}
            creditSlot={<CreditUsageSlot />}
          />
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
  // LANGGRAPH_PUBLIC_URL bypasses it (e.g. behind Cloudflare Tunnel).
  // Read from window.__CONFIG__ (app/layout.tsx).
  const apiUrl =
    (typeof window !== "undefined" && window.__CONFIG__?.LANGGRAPH_PUBLIC_URL) ||
    (typeof window !== "undefined" ? new URL("/api", window.location.href).href : undefined);

  const assistantId =
    (typeof window !== "undefined" && window.__CONFIG__?.LANGGRAPH_ASSISTANT_ID) || "agent";

  // apiUrl is undefined on the first SSR pass, so the runtime builds lazily.
  const client = useMemo(() => new Client({ apiUrl: apiUrl! }), [apiUrl]);

  // eventHandlers runs INSIDE the runtime, before the provider mounts —
  // it can't call useAui directly. A child component mounted inside the
  // provider writes the api + mainThreadId to bridgeRef; the handler
  // reads them at call time.
  const bridgeRef = useRef<RuntimeBridge>({ api: null, mainThreadId: null });

  // ponytail: our own `createLangGraphStream` replaces the upstream
  // `unstable_createLangGraphStream` so we own the stream-build logic
  // (rule of minimal dependencies) and can extend with parentMessageId
  // threading. We don't pass parentMessageId here — the helper derives
  // it from the latest HumanMessage inside the messages array at call
  // time, so the source of truth stays a single line of code and
  // doesn't require message-scoped access (which doesn't exist at this
  // top level of AssistantRuntimeProvider).
  const stream = useMemo(
    () =>
      createLangGraphStream({
        client,
        assistantId,
        streamMode: ["messages", "updates", "custom"],
      }),
    [client, assistantId],
  );

  const eventHandlers = useMemo(() => ({}), []);

  // ponytail: gate the adapter on the same env that the server enforces.
  // When ATTACHMENTS_ENABLED !== "true" the composer renders without an
  // attachment button — no client-side conditional render needed; the
  // runtime skips `adapters.attachments` and assistant-ui hides the
  // picker automatically. Read from window.__CONFIG__ (see app/layout.tsx).
  const attachments = useMemo(
    () =>
      (typeof window !== "undefined" && window.__CONFIG__?.ATTACHMENTS_ENABLED) === "true"
        ? new R2AttachmentAdapter()
        : undefined,
    [],
  );

  const runtime = useLangGraphRuntime({
    unstable_allowCancellation: true,
    unstable_enableMessageQueue: true,
    unstable_threadListAdapter: threadListAdapter,
    // ponytail: aUI's built-in thread-change hook fires once per
    // _mainThreadRemoteId transition, deduped internally — see
    // RemoteThreadListThreadListRuntimeCore._notifyThreadIdChange.
    // We push the URL via plain history.pushState (no Next router), so
    // thread nav doesn't RSC-refetch the page.
    onThreadIdChange: writeUrlForThread,
    stream,
    eventHandlers,
    ...(attachments ? { adapters: { attachments } } : {}),
    create: async () => {
      const { externalId } = await threadListAdapter.initialize!("local");
      return { externalId: externalId! };
    },
    // Empty messages on a fresh thread — state.values has no `messages` key yet.
    // Return `messages` from the active subgraph task so a paused run
    // (e.g. ask_location waiting for the user's location pick) survives a
    // page refresh — the picker card reads the trailing ToolMessage out
    // of those messages and re-renders in the tool-call slot. Also return
    // `uiMessages` so any persisted typedUi state is restored on reload.
    //
    // ponytail: { subgraphs: true } is required when the chat is sitting in
    // a paused subgraph (ask_location etc.). Without it the SDK never asks
    // the server for the subgraph's in-flight state, so the AI message +
    // tool_call emitted inside the subgraph never reach the assistant-ui
    // runtime on reload — see mergeSubgraphMessages for the dedupe rule.
    load: async (externalId) => {
      const state = await client.threads.getState(externalId, undefined, { subgraphs: true });
      const values = state.values as { messages?: unknown; ui?: unknown };
      const interrupts = state.tasks?.at(-1)?.interrupts;
      const messages = mergeSubgraphMessages(
        (values.messages ?? []) as Array<{ id?: string }>,
        state.tasks as ReadonlyArray<unknown>,
      ) as never;

      return {
        messages,
        uiMessages: (values.ui ?? []) as never,
        ...(interrupts?.length ? { interrupts } : {}),
      };
    },
    getCheckpointId: async (threadId, parentMessages) => {
      const history = await client.threads.getHistory(threadId);

      for (const state of history) {
        const stateMessages = (state.values as { messages?: unknown[] }).messages;
        if (!stateMessages || stateMessages.length !== parentMessages.length) {
          continue;
        }
        const hasStableIds =
          parentMessages.every((m) => typeof m.id === "string") &&
          stateMessages.every((m: unknown) => typeof (m as { id?: unknown }).id === "string");
        if (!hasStableIds) continue;
        const isMatch = parentMessages.every(
          (m, i) => m.id === (stateMessages[i] as { id?: string } | undefined)?.id,
        );
        if (isMatch) {
          return state.checkpoint.checkpoint_id ?? null;
        }
      }
      return null;
    },
  });

  const aui = useAui({
    tools: Tools({ toolkit: weatherToolkit }),
    suggestions: Suggestions([
      {
        title: "Please analyze the website https://firetable.tech",
        label: "",
        prompt: "Please analyze the website https://firetable.tech",
      },
      {
        title: "What’s the weather like today?",
        label: "",
        prompt: "What’s the weather like today?",
      },
      {
        title: "I want to buy 2 ETH",
        label: "",
        prompt: "I want to buy 2 ETH",
      },
      {
        title: "Show me my NFTs",
        label: "",
        prompt: "Show me my NFTs",
      },
      {
        title: "Write a Typescript function about `Two Sum`",
        label: "",
        prompt: "Write a Typescript function about `Two Sum`, include the test cases.",
      },
    ]),
  });

  return (
    <AssistantRuntimeProvider aui={aui} runtime={runtime}>
      <AuiRefCapture bridgeRef={bridgeRef} />
      <ThreadUrlShadow />
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

// Sets bridgeRef during render; useAui / useAuiState return stable
// references, so the value is identical on every render.
const AuiRefCapture: FC<{ bridgeRef: RefObject<RuntimeBridge> }> = ({ bridgeRef }) => {
  const api = useAui();
  const mainThreadId = useAuiState((s) => s.threads.mainThreadId);
  bridgeRef.current = { api, mainThreadId };
  return null;
};

// ponytail: the URL is a shadow of the active aUI thread (issue #27).
// We deliberately bypass `next/router` for thread nav: `router.push` on
// this page re-fires the dynamic route's RSC, which double-fires `load()`
// and the adapter `fetch()` — aUI's runtime assumes ONE mount per active
// thread, so the second call hits the network again. Instead we:
//   - push URL via `history.pushState` (URL bar updates; no RSC roundtrip)
//   - hook the runtime's `onThreadIdChange` (passed in `useLangGraphRuntime`
//     below) so user-driven thread switches write the URL automatically.
//   - listen to `popstate` so browser back/forward syncs aUI without a
//     Next.js route change.
// `lastSyncedIdRef` prevents the popstate → switchToThread → onThreadIdChange
// echo from re-pushing.
// ponytail: trust the URL. /chat → aUI's default (placeholder, new
// thread welcome). /chat/<id> → "the active thread is this id".
// React to URL changes (mount, back/forward) by switching aUI; react
// to aUI's `onThreadIdChange` by writing the URL back. No clever
// precheck, no parallel placeholder effect, no lastSyncedIdRef —
// `switchToThread` is idempotent and `onThreadIdChange` already dedupes
// internally. The only failure path is aUI's Promise reject on a
// genuinely-bogus id (404 / cross-user), which we redirect to /chat.
const ThreadUrlShadow: FC = () => {
  const api = useAui();

  // Read thread id off the current path. /chat/<id> → id. /chat (or
  // anything else) → null. window.location (NOT useParams/usePathname)
  // because Next.js's router cache doesn't observe our pushState writes.
  const readUrlThreadId = (): string | null => {
    if (typeof window === "undefined") return null;
    const m = window.location.pathname.match(/^\/chat\/([^/]+)$/);
    return m ? decodeURIComponent(m[1]) : null;
  };

  // URL → aUI: on mount + on browser back/forward. `switchToThread`
  // is idempotent (aUI returns early when already on the target id)
  // and resolves to a Promise that rejects for unknown / cross-user
  // ids — that's our "this URL was bogus" signal, no inference needed.
  useEffect(() => {
    const syncFromUrl = () => {
      const urlThreadId = readUrlThreadId();
      if (!urlThreadId) return;
      void Promise.resolve(
        api.threads().switchToThread(urlThreadId) as unknown as Promise<void>,
      ).catch(() => {
        if (typeof window === "undefined" || window.location.pathname === "/chat") return;
        window.history.replaceState({ threadId: null }, "", "/chat");
      });
    };
    syncFromUrl();
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, [api]);

  return null;
};

// aUI → URL: write side. Module-scope closure passed to
// `useLangGraphRuntime`'s `onThreadIdChange`; the runtime already
// dedupes internally (_notifyThreadIdChange keeps a lastNotifiedThreadId
// ref), so we just sync the URL on every notify.
//
// `remoteId === undefined` → push /chat (placeholder / cleared state,
// e.g. immediately after +New before adapter.initialize resolves;
// we treat that as "user wants /chat for now"). Real uuid → push
// /chat/<uuid>. No preconditions, no reads of aUI's state.
//
const writeUrlForThread = (remoteId: string | undefined): void => {
  if (typeof window === "undefined") return;
  const target = remoteId ? `/chat/${remoteId}` : "/chat";
  if (window.location.pathname === target) return;
  window.history.pushState(remoteId ? { threadId: remoteId } : { threadId: null }, "", target);
};
