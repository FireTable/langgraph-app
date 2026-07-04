import { START, END, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { SystemMessage, type BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { scheduleBackgroundNode } from "@/backend/node/schedule-background-node";
import { capturingHandler } from "@/backend/callbacks";
import { renameThreadAgentNode } from "@/backend/node/rename-thread-agent-node";
import { weatherAgent } from "@/backend/agent/weather-agent";
import { chatAgent } from "@/backend/agent/chat-agent";
import { cryptoAgent } from "@/backend/agent/crypto-agent";
import { codeAgent } from "@/backend/agent/code-agent";
import { routerAgentNode } from "@/backend/node/router-agent-node";
import { checkpointer } from "@/backend/checkpointer";
import { store } from "@/backend/store";
import { RouterAgentState } from "@/backend/state";
import { chatModel } from "@/backend/model";
import { ALL_TOOLS, WEATHER_TOOLS, CRYPTO_TOOLS, CODE_TOOLS } from "@/backend/tool";
import { CHAT_AGENT_PROMPT, WEATHER_AGENT_PROMPT } from "@/backend/prompt/system";
import { getThreadTitle } from "@/lib/threads/queries";
import { DEFAULT_THREAD_TITLE } from "@/lib/constants";
import { buildSystemMessageWithMemory } from "@/backend/memory/template";

// USE_SUBGRAPH=true switches the compiled graph between two topologies.
// Default (false / unset): inlined — flatten weather/chat/crypto model+tool loops
// into the parent graph. This is the safe workaround for the
// EventStreamCallbackHandler "Run ID not found in run map" bug that
// LangGraph JS subgraphs trigger under @langchain/core@1.2.1.
// See memory/langgraph-subgraph-run-map-bug.md.
// Set USE_SUBGRAPH=true to use the compiled weatherAgent / chatAgent /
// cryptoAgent subgraphs instead. Both topologies are kept in this file
// in sync — if you change a model, prompt, or tool set, update both builders.
const USE_SUBGRAPH = process.env.USE_SUBGRAPH === "true" || process.env.USE_SUBGRAPH === "1";

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

// ---------------------------------------------------------------------------
// Subgraph version — preferred when the upstream run-map bug is fixed.
// Reads the three compiled subgraphs and wires them as opaque nodes.
// ---------------------------------------------------------------------------
function buildSubgraph() {
  return (
    new StateGraph(RouterAgentState)
      .addNode("routerAgent", routerAgentNode)
      .addNode("chatAgent", chatAgent)
      .addNode("weatherAgent", weatherAgent)
      .addNode("cryptoAgent", cryptoAgent)
      .addNode("codeAgent", codeAgent)
      .addNode("scheduleBackground", scheduleBackgroundNode)
      .addNode("renameThreadAgent", renameThreadAgentNode)
      // Topology:
      //   START ──▶ routerAgent ──▶ (sub-agent) ──▶ scheduleBackground ──▶ END
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
      // scheduleBackground is the chat's last node before END. It fires
      // the `background_agent` graph (registered separately in
      // langgraph.json) and returns `{}` immediately — that graph does
      // `last_message_at` touch + threadSummarizeNode work on its own
      // thread. See backend/node/schedule-background-node.ts for the
      // fire-and-forget pattern; see backend/background-agent.ts for
      // what the background graph runs.
      .addEdge(START, "routerAgent")
      .addConditionalEdges("routerAgent", routeToSubAgent, [
        "weatherAgent",
        "chatAgent",
        "cryptoAgent",
        "codeAgent",
      ])
      .addEdge("chatAgent", "scheduleBackground")
      .addEdge("weatherAgent", "scheduleBackground")
      .addEdge("cryptoAgent", "scheduleBackground")
      .addEdge("codeAgent", "scheduleBackground")
      .addEdge("scheduleBackground", END)
      .addConditionalEdges(START, shouldRenameRouter, {
        renameThreadAgent: "renameThreadAgent",
        __end__: END,
      })
  );
}

// ---------------------------------------------------------------------------
// Inlined version (default) — flatten weather-agent.ts + chat-agent.ts +
// crypto-agent.ts model/tool loops into the parent graph. Keep in sync
// with those files.
// ---------------------------------------------------------------------------
async function weatherModelNode({ messages }: { messages: BaseMessage[] }, config: RunnableConfig) {
  const history = messages.filter((m) => !(m instanceof SystemMessage));
  const sysMsg = await buildSystemMessageWithMemory(WEATHER_AGENT_PROMPT, config);
  const response = await chatModel.bindTools(WEATHER_TOOLS).invoke([sysMsg, ...history], config);
  return { messages: [response] };
}

async function chatModelNode({ messages }: { messages: BaseMessage[] }, config: RunnableConfig) {
  const history = messages.filter((m) => !(m instanceof SystemMessage));
  const sysMsg = await buildSystemMessageWithMemory(CHAT_AGENT_PROMPT, config);
  const response = await chatModel.bindTools(ALL_TOOLS).invoke([sysMsg, ...history], config);
  return { messages: [response] };
}

async function cryptoModelNode({ messages }: { messages: BaseMessage[] }, config: RunnableConfig) {
  const { CRYPTO_AGENT_PROMPT } = await import("@/backend/prompt/system");
  const history = messages.filter((m) => !(m instanceof SystemMessage));
  const sysMsg = await buildSystemMessageWithMemory(CRYPTO_AGENT_PROMPT, config);
  const response = await chatModel.bindTools(CRYPTO_TOOLS).invoke([sysMsg, ...history], config);
  return { messages: [response] };
}

async function codeModelNode({ messages }: { messages: BaseMessage[] }, config: RunnableConfig) {
  const { CODE_AGENT_PROMPT } = await import("@/backend/prompt/system");
  const history = messages.filter((m) => !(m instanceof SystemMessage));
  const sysMsg = await buildSystemMessageWithMemory(CODE_AGENT_PROMPT, config);
  const response = await chatModel.bindTools(CODE_TOOLS).invoke([sysMsg, ...history], config);
  return { messages: [response] };
}

const weatherToolNode = new ToolNode(WEATHER_TOOLS);
const chatToolNode = new ToolNode(ALL_TOOLS);
const cryptoToolNode = new ToolNode(CRYPTO_TOOLS);
const codeToolNode = new ToolNode(CODE_TOOLS);

// toolsCondition only inspects the last AI message, so its return value is
// independent of what the tool node is named — we just remap "tools" → our
// local node and END → scheduleBackground.
function weatherRoute(state: { messages: BaseMessage[] }) {
  return toolsCondition(state) === END ? "scheduleBackground" : "weatherTools";
}
function chatRoute(state: { messages: BaseMessage[] }) {
  return toolsCondition(state) === END ? "scheduleBackground" : "chatTools";
}
function cryptoRoute(state: { messages: BaseMessage[] }) {
  return toolsCondition(state) === END ? "scheduleBackground" : "cryptoTools";
}
function codeRoute(state: { messages: BaseMessage[] }) {
  return toolsCondition(state) === END ? "scheduleBackground" : "codeTools";
}

function buildInlined() {
  return (
    new StateGraph(RouterAgentState)
      .addNode("routerAgent", routerAgentNode)
      .addNode("weatherModel", weatherModelNode)
      .addNode("weatherTools", weatherToolNode)
      .addNode("chatModel", chatModelNode)
      .addNode("chatTools", chatToolNode)
      .addNode("cryptoModel", cryptoModelNode)
      .addNode("cryptoTools", cryptoToolNode)
      .addNode("codeModel", codeModelNode)
      .addNode("codeTools", codeToolNode)
      .addNode("scheduleBackground", scheduleBackgroundNode)
      .addNode("renameThreadAgent", renameThreadAgentNode)
      // Topology (mirrors buildSubgraph's edge pattern):
      //   START ──▶ routerAgent ──▶ (model | tools)* ──▶ scheduleBackground ──▶ END
      //   START ─────────────────────────────────────▶ renameThreadAgent (parallel, leaf)
      //
      // ask_location's picker card is owned by the weather model/tool loop
      // (see components/tool-ui/ask-location). ask_crypto_intent's picker
      // card is owned by the crypto loop (see components/tool-ui/crypto).
      // write_code's editor card is owned by the code loop
      // (see components/tool-ui/code).
      //
      // See buildSubgraph for the scheduleBackground rationale — same
      // node, same fire-and-forget contract, owns every turn-end side
      // effect (last_message_at touch + windowed summarize) by handing
      // them off to the registered background_agent graph.
      .addEdge(START, "routerAgent")
      .addConditionalEdges("routerAgent", routeToSubAgent, {
        weatherAgent: "weatherModel",
        chatAgent: "chatModel",
        cryptoAgent: "cryptoModel",
        codeAgent: "codeModel",
      })
      .addConditionalEdges("weatherModel", weatherRoute, ["weatherTools", "scheduleBackground"])
      .addEdge("weatherTools", "weatherModel")
      .addConditionalEdges("chatModel", chatRoute, ["chatTools", "scheduleBackground"])
      .addEdge("chatTools", "chatModel")
      .addConditionalEdges("cryptoModel", cryptoRoute, ["cryptoTools", "scheduleBackground"])
      .addEdge("cryptoTools", "cryptoModel")
      .addConditionalEdges("codeModel", codeRoute, ["codeTools", "scheduleBackground"])
      .addEdge("codeTools", "codeModel")
      // .addEdge("scheduleBackground", END)
      .addConditionalEdges(START, shouldRenameRouter, {
        renameThreadAgent: "renameThreadAgent",
        __end__: END,
      })
  );
}

const builder = USE_SUBGRAPH ? buildSubgraph() : buildInlined();

// Exported for the topology smoke test (tests/backend/agent-topologies.test.ts).
// Don't use these directly in app code — go through `graph`.
export { buildSubgraph, buildInlined };

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
const compiled = builder.compile({ checkpointer, store });
type WithConfigPregel = (config: Record<string, unknown>) => typeof compiled;
export const graph = (compiled.withConfig as unknown as WithConfigPregel)({
  callbacks: [capturingHandler],
});
