import { START, END, StateGraph } from "@langchain/langgraph";
import { triggerBackgroundAgentNode } from "@/backend/node/trigger-background-agent-node";
import { capturingHandler } from "@/backend/callbacks";
import { CreditTrackingHandler } from "@/lib/credit/callback";
import { renameThreadAgentNode } from "@/backend/node/rename-thread-agent-node";
import { weatherAgent } from "@/backend/agent/weather-agent";
import { chatAgent } from "@/backend/agent/chat-agent";
import { cryptoAgent } from "@/backend/agent/crypto-agent";
import { codeAgent } from "@/backend/agent/code-agent";
import { routerAgentNode } from "@/backend/node/router-agent-node";
import { checkpointer } from "@/backend/checkpointer";
import { store } from "@/backend/store";
import { RouterAgentState } from "@/backend/state";
import { getThreadTitle } from "@/lib/threads/queries";
import { DEFAULT_THREAD_TITLE } from "@/lib/constants";

// After the router speaks, decide which sub-agent gets the turn.
// Falls back to chatAgent if the router hasn't run yet or its
// decision didn't make it into state.
function routeToSubAgent({
  routerDecision,
}: {
  routerDecision?: { next: "weatherAgent" | "chatAgent" | "cryptoAgent" | "codeAgent" };
}): "weatherAgent" | "chatAgent" | "cryptoAgent" | "codeAgent" {
  return routerDecision?.next ?? "chatAgent";
}

// ponytail: renameThreadAgent only needs to run once per thread — the
// first time the user sends a message. After that, threads.title is
// already set; re-invoking the LLM every turn (interrupt + resume,
// regenerate, follow-up) wastes tokens. Query the title from the DB
// before entering; if it has been replaced from the default placeholder,
// skip the node entirely. The conditional edge wires both branches from
// START, so renameThreadAgent is never even entered (no callback, no
// span) when the LLM-generated title already exists.
async function shouldRenameRouter(
  _state: unknown,
  config: { configurable?: { thread_id?: string } },
): Promise<"renameThreadAgent" | typeof END> {
  const threadId = config.configurable?.thread_id;
  if (typeof threadId !== "string" || !threadId) return END;
  const title = await getThreadTitle(threadId);
  // ponytail: the column has `notNull().default(DEFAULT_THREAD_TITLE)`
  // ("New Chat"), so title is always a non-null string in the DB. The
  // "auto-rename not yet run" signal is `title === DEFAULT_THREAD_TITLE`;
  // anything else is the LLM-generated title from a prior turn.
  if (typeof title === "string" && title !== DEFAULT_THREAD_TITLE) return END;
  return "renameThreadAgent";
}

export const builder = new StateGraph(RouterAgentState)
  .addNode("routerAgent", routerAgentNode)
  .addNode("chatAgent", chatAgent)
  .addNode("weatherAgent", weatherAgent)
  .addNode("cryptoAgent", cryptoAgent)
  .addNode("codeAgent", codeAgent)
  .addNode("triggerBackgroundAgent", triggerBackgroundAgentNode)
  .addNode("renameThreadAgent", renameThreadAgentNode)
  // Topology:
  //   START ──▶ routerAgent ──▶ (sub-agent) ──▶ triggerBackgroundAgent ──▶ END
  //   START ─────────────────────────────────▶ renameThreadAgent (parallel, leaf)
  //
  // ask_location's picker card is owned by the weather subgraph
  // (see backend/agent/weather-agent.ts + components/tool-ui/ask-location).
  // ask_crypto_intent's picker card is owned by the crypto subgraph
  // (see backend/agent/crypto-agent.ts + components/tool-ui/crypto).
  // write_code's editor card is owned by the code subgraph
  // (see backend/agent/code-agent.ts + components/tool-ui/code).
  //
  // renameThreadAgent runs as a parallel leaf off the main response
  // path (END). The graph invocation only returns after ALL active
  // branches complete, but the chat stream ends on the END branch,
  // so the user sees no rename latency.
  //
  // triggerBackgroundAgent is the chat's last node before END. It fires
  // the `background_agent` graph (registered separately in
  // langgraph.json) and returns `{}` immediately — that graph does
  // `last_message_at` touch + threadSummarizeNode work on its own
  // thread. See backend/node/trigger-background-agent-node.ts for the
  // fire-and-forget pattern; see backend/background-agent.ts for
  // what the background graph runs.
  .addEdge(START, "routerAgent")
  .addConditionalEdges("routerAgent", routeToSubAgent, [
    "weatherAgent",
    "chatAgent",
    "cryptoAgent",
    "codeAgent",
  ])
  .addEdge("chatAgent", "triggerBackgroundAgent")
  .addEdge("weatherAgent", "triggerBackgroundAgent")
  .addEdge("cryptoAgent", "triggerBackgroundAgent")
  .addEdge("codeAgent", "triggerBackgroundAgent")
  .addEdge("triggerBackgroundAgent", END)
  .addConditionalEdges(START, shouldRenameRouter, {
    renameThreadAgent: "renameThreadAgent",
    __end__: END,
  });

// ponytail: one handler per process (per module), shared across all
// concurrent runs AND across every Pregel that wires it via withConfig.
// The handler now lives in backend/callbacks.ts so the background_agent
// graph (registered separately in langgraph.json) can wrap itself with
// the same singleton — span writes from both graphs land in the same
// in-memory Map and the same bulkInsert path.
//
// Concurrent threads cross-mixing in the in-memory buffer is a known
// ceiling — single-dev-session acceptable; revisit when we move to prod
// checkpointing.

// ponytail: withConfig on CompiledStateGraph has two overloads: the
// first expects LangGraphRunnableConfig + streamTransformers (general
// LC use), the second expects PregelOptions (LangGraph-flavored —
// accepts `callbacks` directly). TS can't pick for a bare callbacks
// object — cast to the Pregel-options overload at the call site.
const compiled = builder.compile({ checkpointer, store, name: "mainAgent" });
type WithConfigPregel = (config: Record<string, unknown>) => typeof compiled;
const creditTrackingHandler = new CreditTrackingHandler();
export const graph = (compiled.withConfig as unknown as WithConfigPregel)({
  callbacks: [capturingHandler, creditTrackingHandler],
  subgraphs: true,
});
