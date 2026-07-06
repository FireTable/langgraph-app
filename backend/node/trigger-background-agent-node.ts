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

type ScheduleConfig = {
  configurable?: {
    userId?: unknown;
    thread_id?: unknown;
  };
};

type ScheduleState = {
  messages?: unknown[];
};

type PreparedCall = {
  userId: string;
  threadId: string;
  messages: unknown[];
  // ponytail: last HumanMessage id from the chat invoke — the same
  // id assistant-ui stamps on the user message. The observability
  // API uses it to scope in-flight runs to the current turn (the
  // chat invoke and any background dispatch share thread_id).
  parentMessageId: string | null;
};

function readBackgroundCall(state: ScheduleState, config: ScheduleConfig): PreparedCall | null {
  const userId = config.configurable?.userId;
  const threadId = config.configurable?.thread_id;
  if (typeof userId !== "string" || userId.length === 0) return null;
  if (typeof threadId !== "string" || threadId.length === 0) return null;

  return {
    userId,
    threadId,
    messages: state.messages ?? [],
    parentMessageId: lastHumanMessageId(state.messages),
  };
}

async function dispatchViaCreate(input: PreparedCall): Promise<void> {
  await langGraphClient.runs.create(input.threadId, "background_agent", {
    multitaskStrategy: "enqueue",
    input: {
      messages: input.messages,
      userId: input.userId,
      threadId: input.threadId,
    },
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
  const prepared = readBackgroundCall(state, config);
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
