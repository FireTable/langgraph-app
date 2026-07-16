import { START, END, StateGraph } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { triggerBackgroundAgentNode } from "@/backend/node/trigger-background-agent-node";
import { capturingHandler, creditTrackingHandler } from "@/backend/callbacks";
import { renameThreadAgentNode } from "@/backend/node/rename-thread-agent-node";
import { weatherAgent } from "@/backend/agent/weather-agent";
import { chatAgent } from "@/backend/agent/chat-agent";
import { cryptoAgent } from "@/backend/agent/crypto-agent";
import { codeAgent } from "@/backend/agent/code-agent";
import { kbAgent } from "@/backend/agent/kb-agent";
import { routerAgentNode } from "@/backend/node/router-agent-node";
import { checkpointer } from "@/backend/checkpointer";
import { store } from "@/backend/store";
import { RouterAgentState } from "@/backend/state";
import { getThreadTitle } from "@/lib/threads/queries";
import { DEFAULT_THREAD_TITLE } from "@/lib/constants";
import { isFilePart } from "@/lib/kb/extract";

// After the router speaks, decide which sub-agent gets the turn AND
// whether to fan out to renameThreadAgent in parallel. Falls back to
// chatAgent if the router hasn't run yet or its decision didn't make
// it into state. kbAgent routes back to the router after stamping a
// `kb_ref` sibling onto the PDF file part, so a SECOND router pass
// picks the final sub-agent (chat / weather / etc.) — the PDF is
// still in the message (file part preserved) but the kb_ref sibling
// marks it as already-ingested, so the PDF-short-circuit no longer
// fires. On that second pass the rename fanout also fires.
//
// Returning an ARRAY of destinations makes LangGraph run the listed
// nodes in parallel; returning a single string is the normal one-shot
// routing case. So we collapse the sub-agent pick + rename fanout into
// a single conditional edge to satisfy langgraph's "one condition per
// source node" rule.
function hasPendingFilePart(messages: { content: unknown }[]): boolean {
  return messages.some(
    (m) => m instanceof HumanMessage && Array.isArray(m.content) && m.content.some(isFilePart),
  );
}

type SubAgent = "weatherAgent" | "chatAgent" | "cryptoAgent" | "codeAgent" | "kbAgent";

async function routeAndMaybeRename(
  state: { messages: { content: unknown }[]; routerDecision?: { next: SubAgent } },
  config: { configurable?: { thread_id?: string } },
): Promise<SubAgent | (string | SubAgent)[]> {
  const subAgent: SubAgent = state.routerDecision?.next ?? "chatAgent";
  // ponytail: renameThreadAgent only needs to run once per thread — the
  // first time the user sends a message. After that, threads.title is
  // already set; re-invoking the LLM every turn (interrupt + resume,
  // regenerate, follow-up) wastes tokens.
  //
  // Skip while a raw file part is present (kbAgent hasn't rewritten it
  // yet) — for PDF uploads the SECOND routerAgent pass after kbAgent
  // sees the kb_ref in place and fires rename.
  if (hasPendingFilePart(state.messages)) return subAgent;
  const threadId = config.configurable?.thread_id;
  if (typeof threadId !== "string" || !threadId) return subAgent;
  const title = await getThreadTitle(threadId);
  // ponytail: the column has `notNull().default(DEFAULT_THREAD_TITLE)`
  // ("New Chat"), so title is always a non-null string in the DB. The
  // "auto-rename not yet run" signal is `title === DEFAULT_THREAD_TITLE`;
  // anything else is the LLM-generated title from a prior turn.
  if (typeof title === "string" && title !== DEFAULT_THREAD_TITLE) return subAgent;
  // Array return = parallel fanout (langgraph runs both nodes).
  return ["renameThreadAgent", subAgent];
}

export const builder = new StateGraph(RouterAgentState)
  .addNode("routerAgent", routerAgentNode)
  .addNode("chatAgent", chatAgent)
  .addNode("weatherAgent", weatherAgent)
  .addNode("cryptoAgent", cryptoAgent)
  .addNode("codeAgent", codeAgent)
  .addNode("kbAgent", kbAgent)
  .addNode("triggerBackgroundAgent", triggerBackgroundAgentNode)
  .addNode("renameThreadAgent", renameThreadAgentNode)
  // Topology (issue #13 v2):
  //   START ──▶ routerAgent ──┬──▶ (sub-agent | kbAgent) ──▶ triggerBackgroundAgent ──▶ END
  //                           └──▶ renameThreadAgent   (terminal, no outgoing edge needed)
  //
  // kbAgent loops back to routerAgent after stamping a `kb_ref`
  // sibling onto the PDF file part, so a SECOND router pass picks
  // the final sub-agent (chat / weather / etc.) — the file part is
  // preserved (not replaced), but the kb_ref sibling marks it as
  // already-ingested and the PDF-short-circuit no longer fires.
  //
  // ask_location's picker card is owned by the weather subgraph
  // (see backend/agent/weather-agent.ts + components/tool-ui/ask-location).
  // ask_crypto_intent's picker card is owned by the crypto subgraph
  // (see backend/agent/crypto-agent.ts + components/tool-ui/crypto).
  // write_code's editor card is owned by the code subgraph
  // (see backend/agent/code-agent.ts + components/tool-ui/code).
  //
  // triggerBackgroundAgent is the chat's last sub-agent step. It fires
  // the `background_agent` graph (registered separately in
  // langgraph.json) and returns `{}` immediately — that graph does
  // `last_message_at` touch + threadSummarizeNode work on its own
  // thread. See backend/node/trigger-background-agent-node.ts for the
  // fire-and-forget pattern; see backend/background-agent.ts for
  // what the background graph runs.
  //
  // routeAndMaybeRename collapses the sub-agent pick + rename fanout
  // into one conditional edge (langgraph forbids two conditions on the
  // same source node). When the function returns an array of two
  // names, langgraph runs them in parallel. The rename fires only
  // when the messages are clean (no raw file part) AND the thread
  // title is still the default placeholder — see routeAndMaybeRename.
  .addEdge(START, "routerAgent")
  .addConditionalEdges("routerAgent", routeAndMaybeRename, {
    chatAgent: "chatAgent",
    weatherAgent: "weatherAgent",
    cryptoAgent: "cryptoAgent",
    codeAgent: "codeAgent",
    kbAgent: "kbAgent",
    renameThreadAgent: "renameThreadAgent",
  })
  .addEdge("chatAgent", "triggerBackgroundAgent")
  .addEdge("weatherAgent", "triggerBackgroundAgent")
  .addEdge("cryptoAgent", "triggerBackgroundAgent")
  .addEdge("codeAgent", "triggerBackgroundAgent")
  // ponytail: kbAgent loops back to the router — after it stamps a
  // `kb_ref` sibling onto the PDF file part, the router's
  // PDF-short-circuit no longer fires (the PDF is still in the
  // message but it's marked as already-ingested via the sibling) and
  // the router routes to the final sub-agent (chatAgent, etc.).
  .addEdge("kbAgent", "routerAgent")
  .addEdge("triggerBackgroundAgent", END);

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
export const graph = (compiled.withConfig as unknown as WithConfigPregel)({
  callbacks: [capturingHandler, creditTrackingHandler],
  subgraphs: true,
});
