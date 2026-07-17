// ponytail: chat response edge's terminal node. Sits between
// `subAgent` and `END` in the main graph (`subAgent →
// triggerBackgroundAgentNode → END`). Its only job is to ask LangGraph to
// run the `background_agent` graph (last_message_at touch +
// threadSummarizeNode work), then return immediately.
//
// Dispatch: SDK `client.runs.create(...)` over HTTP to langgraphjs
// dev's own API on :2024. Same pattern memory-template uses. Decoupled
// from the chat invoke's runtime context — no LangGraph AbortSignal
// cascade (an in-process `graph.invoke(...)` from this node would be
// killed by the parent invoke's composed signal the moment the chat
// invoke ENDs, so the only clean path for a fire-and-forget background
// is the cross-process HTTP one). Dev-server behavior determines
// whether the call blocks (no worker pool locally, yes; LangSmith
// Deployments, no).
//
// Span tagging: background_agent runs through the shared
// capturingHandler singleton from backend/callbacks.ts. Its LLM/DB
// spans land in the same observability row set as the chat invoke.
import { langGraphClient } from "@/lib/langgraph/client";
import { lastHumanMessageId } from "@/lib/langgraph/last-human-message-id";
import { prepareMessagesForInvoke } from "@/backend/memory/template";
import type { BaseMessage } from "@langchain/core/messages";

type ScheduleConfig = {
  configurable?: {
    userId?: unknown;
    thread_id?: unknown;
  };
};

type ScheduleState = {
  messages?: BaseMessage[];
};

type PreparedCall = {
  userId: string;
  threadId: string;
  messages: BaseMessage[];
  parseMessages: BaseMessage[];
  // ponytail: last HumanMessage id from the chat invoke — the same
  // id assistant-ui stamps on the user message. The observability
  // API uses it to scope in-flight runs to the current turn (the
  // chat invoke and any background dispatch share thread_id).
  parentMessageId: string | null;
};

async function readBackgroundCall(
  state: ScheduleState,
  config: ScheduleConfig,
): Promise<PreparedCall | null> {
  const userId = config.configurable?.userId;
  const threadId = config.configurable?.thread_id;
  if (typeof userId !== "string" || userId.length === 0) return null;
  if (typeof threadId !== "string" || threadId.length === 0) return null;

  // ponytail: parseMessages is the result of prepareMessagesForInvoke —
  // kb_ref → resolved text. It's NOT what we dispatch to background_agent
  // (we pass the original state.messages below). The point of computing
  // it here is to keep the KB-resolved path from running on background
  // dispatch: if we ever rewrote state.messages with the resolved version,
  // the reducer would dedup-replace every HumanMessage by id and the
  // kb_ref siblings would be lost for the rest of the thread — every
  // follow-up chat turn would re-hit the DB and miss the KB cache. So
  // we run the resolve here as a side-effect that proves the path is
  // safe, then throw it away and dispatch the original. (The cache hit
  // also warms getKbDocForResolve for the chat agent's own invoke.)
  const parseMessages = await prepareMessagesForInvoke(
    (state.messages ?? []) as BaseMessage[],
    [],
    userId ?? undefined,
  );

  return {
    userId,
    threadId,
    messages: state.messages as BaseMessage[],
    parentMessageId: lastHumanMessageId(state.messages),
    parseMessages,
  };
}

async function dispatchViaCreate(input: PreparedCall): Promise<void> {
  await langGraphClient.runs.create(input.threadId, "background_agent", {
    multitaskStrategy: "enqueue",
    input: input,
    config: {
      configurable: {
        userId: input.userId,
        thread_id: input.threadId,
      },
    },
    // ponytail: stamp parent_message_id so the observability per-turn
    // GET can scope langGraphClient.runs.list(threadId, { status: "running" })
    // to the current chat turn. Same key the CapturingHandler stamps on
    // span rows — the API uses one filter to match both DB rows and
    // in-flight runs to a single human turn.
    metadata: { parent_message_id: input.parentMessageId },
  });
}

export async function triggerBackgroundAgentNode(
  state: ScheduleState,
  config: ScheduleConfig,
): Promise<Record<string, never>> {
  const prepared = await readBackgroundCall(state, config);
  if (!prepared) return {};

  // ponytail: must await so SDK rejections propagate to the catch
  // below. Without the await, dispatchViaCreate's thrown error
  // escapes as an unhandled rejection and the chat invoke never
  // learns the dispatch failed. SDK runs.create returns once the
  // run is enqueued — it does NOT wait for the background graph
  // to complete, so this await is bounded to one HTTP round-trip.
  try {
    await dispatchViaCreate(prepared);
  } catch (err) {
    console.error("[triggerBackgroundAgentNode] create path failed:", err);
  }

  return {};
}
