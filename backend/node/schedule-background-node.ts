// ponytail: chat response edge's terminal node. Sits between
// `subAgent` and `END` in the main graph (`subAgent →
// scheduleBackground → END`). Its only job is to ask LangGraph to
// run the `background_agent` graph (last_message_at touch +
// threadSummarizeNode work), then return immediately.
//
// Two dispatch paths controlled by `INVOKE_BACKGROUND_AGENT`:
//
//   - INVOKE_BACKGROUND_AGENT unset / false (default):
//       SDK `client.runs.create(...)` over HTTP to langgraphjs dev's
//       own API on :2024. Same pattern memory-template uses. Decoupled
//       from the chat invoke's runtime context — no LangGraph
//       AbortSignal cascade. Dev-server behavior determines whether
//       the call blocks (no worker pool locally, yes; LangSmith
//       Deployments, no).
//
//   - INVOKE_BACKGROUND_AGENT=true:
//       In-process `backgroundAgentGraph.invoke(...)`. Fire-and-forget
//       — chat invoke proceeds to END without awaiting the background
//       graph. Subject to PregelRunner signal cascade: when the chat
//       invoke aborts its AbortSignal on END, the in-process background
//       invoke rejects with `Error: Abort` (LangChainTracer surfaces
//       that as "No chain run to end"). Useful as a control case to
//       compare timelines against the create path.
//
// Shared param prep: both branches go through `readBackgroundCall`,
// so the background_agent graph receives identical `messages`,
// `userId`, and `threadId` regardless of which dispatch path is
// active.
//
// Span tagging: both paths reach the same `background_agent` graph,
// wrapped with the shared capturingHandler singleton from
// backend/callbacks.ts. Their LLM/DB spans land in the same
// observability row set as the chat invoke.
import { Client } from "@langchain/langgraph-sdk";
import { graph as backgroundAgentGraph } from "@/backend/background-agent";

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
};

// ponytail: default matches memory-template's ChatConfigurable.delay_seconds
// (3). Picked up from env so operators can tune without redeploy.
const BACKGROUND_AFTER_SECONDS = Number.parseInt(
  process.env.BACKGROUND_AGENT_AFTER_SECONDS ?? "3",
  10,
);

// ponytail: read the dispatch flag at call time (not module load) so
// tests can flip it via vi.stubEnv() per describe block. Both branches
// below re-evaluate this so mid-run changes are picked up too.
function useInProcessInvoke(): boolean {
  return (
    process.env.INVOKE_BACKGROUND_AGENT === "true" || process.env.INVOKE_BACKGROUND_AGENT === "1"
  );
}

// Shared param construction. Returns null when identity check fails
// (caller short-circuits with no dispatch). Both dispatch branches
// call this so the parameters reaching background_agent stay in
// lockstep — no risk of "invoke path passes extra/less fields than
// create path" drift.
function readBackgroundCall(state: ScheduleState, config: ScheduleConfig): PreparedCall | null {
  const userId = config.configurable?.userId;
  const threadId = config.configurable?.thread_id;
  if (typeof userId !== "string" || userId.length === 0) return null;
  if (typeof threadId !== "string" || threadId.length === 0) return null;
  return {
    userId,
    threadId,
    messages: state.messages ?? [],
  };
}

async function dispatchViaCreate(input: PreparedCall): Promise<void> {
  const client = new Client({
    apiUrl: process.env.LANGGRAPH_API_URL ?? "http://localhost:2024",
    apiKey: process.env.LANGCHAIN_API_KEY || undefined,
  });
  await client.runs.create(input.threadId, "background_agent", {
    multitaskStrategy: "enqueue",
    afterSeconds:
      Number.isFinite(BACKGROUND_AFTER_SECONDS) && BACKGROUND_AFTER_SECONDS >= 0
        ? BACKGROUND_AFTER_SECONDS
        : 3,
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
  });
}

// ponytail: original in-process path retained for the A/B comparison
// the user asked for. Fire-and-forget + .catch matches the
// pre-fix shape: chain invoke sees AbortSignal cascade on chat END,
// logs `[scheduleBackground] invoke path failed: Error: Abort`, and
// continues silently. Don't "fix" the cascade — it's the diagnostic.
function dispatchViaInvoke(input: PreparedCall): Promise<unknown> {
  return backgroundAgentGraph
    .invoke(
      // ponytail: cast — chat-graph state.messages is `BaseMessage[]`,
      // but `BaseMessage` doesn't expose {type, content, id} typing
      // without runtime resolves. The background agent only reads
      // `type`, `id`, `content` from each row, so the structural
      // shape matches even when TS can't see it through the union.
      {
        messages: input.messages,
        userId: input.userId,
        threadId: input.threadId,
      } as never,
      {
        configurable: {
          userId: input.userId,
          thread_id: input.threadId,
        },
      },
    )
    .catch((err: unknown) => {
      console.error("[scheduleBackground] invoke path failed:", err);
    });
}

export async function scheduleBackgroundNode(
  state: ScheduleState,
  config: ScheduleConfig,
): Promise<Record<string, never>> {
  const prepared = readBackgroundCall(state, config);
  if (!prepared) return {};

  const viaInvoke = useInProcessInvoke();

  try {
    if (viaInvoke) {
      // ponytail: fire-and-forget. dispatchViaInvoke swallows its own
      // rejections internally (the .catch lives inside it), so the
      // outer try/catch below only sees the create-path's exception.
      dispatchViaInvoke(prepared);
    } else {
      // ponytail: must await so SDK rejections propagate to the catch
      // below. Without the await, dispatchViaCreate's thrown error
      // escapes as an unhandled rejection and the chat invoke never
      // learns the dispatch failed. SDK runs.create returns once the
      // run is enqueued — it does NOT wait for the background graph
      // to complete, so this await is bounded to one HTTP round-trip.
      await dispatchViaCreate(prepared);
    }
  } catch (err) {
    console.error(`[scheduleBackground] ${viaInvoke ? "invoke" : "create"} path failed:`, err);
  }

  return {};
}
