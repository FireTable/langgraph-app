import { START, END, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { CapturingHandler } from "@/backend/observability/callback-collector";
import { bulkInsertSpans } from "@/lib/observability/queries";
import { renameThreadAgentNode } from "@/backend/node/rename-thread-agent-node";
import { afterAgentNode } from "@/backend/node/after-agent-node";
import { threadSummarizeNode } from "@/backend/node/thread-summarize-node";
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
): Promise<"renameThreadAgent" | "__end__"> {
  const threadId = config.configurable?.thread_id;
  if (typeof threadId !== "string" || !threadId) return "__end__";
  const title = await getThreadTitle(threadId);
  // ponytail: the column has `notNull().default(DEFAULT_THREAD_TITLE)`
  // ("New Chat"), so title is always a non-null string in the DB. The
  // "auto-rename not yet run" signal is `title === DEFAULT_THREAD_TITLE`;
  // anything else is the LLM-generated title from a prior turn.
  if (typeof title === "string" && title !== DEFAULT_THREAD_TITLE) return "__end__";
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
      .addNode("afterAgent", afterAgentNode)
      .addNode("renameThreadAgent", renameThreadAgentNode)
      .addNode("threadSummarize", threadSummarizeNode)
      .addNode("weatherAgent", weatherAgent)
      .addNode("cryptoAgent", cryptoAgent)
      .addNode("codeAgent", codeAgent)
      // Sequential: START → routerAgent → (weatherAgent | chatAgent | cryptoAgent | codeAgent) → afterAgent → threadSummarize → END.
      // ask_location's picker card is owned by the weather subgraph
      // (see backend/agent/weather-agent.ts + components/tool-ui/ask-location).
      // ask_crypto_intent's picker card is owned by the crypto subgraph
      // (see backend/agent/crypto-agent.ts + components/tool-ui/crypto).
      // write_code's editor card is owned by the code subgraph
      // (see backend/agent/code-agent.ts + components/tool-ui/code).
      // renameThreadAgent is wired off START so its DB side-effect runs in
      // parallel without touching the messages channel. The conditional
      // edge from START routes around the node when threads.title is
      // already set (re-invoke / interrupt-resume / regenerate), so the
      // LLM title-generation only runs on the first turn of a new thread.
      // threadSummarize is a pure side-effect node (no messages channel
      // writes), self-skips when userMessageCount <= THRESHOLD.
      .addEdge(START, "routerAgent")
      .addConditionalEdges("routerAgent", routeToSubAgent, [
        "weatherAgent",
        "chatAgent",
        "cryptoAgent",
        "codeAgent",
      ])
      .addEdge("chatAgent", "afterAgent")
      .addEdge("weatherAgent", "afterAgent")
      .addEdge("cryptoAgent", "afterAgent")
      .addEdge("codeAgent", "afterAgent")
      .addEdge("afterAgent", "threadSummarize")
      .addEdge("threadSummarize", END)
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
async function weatherModelNode({ messages }: { messages: BaseMessage[] }) {
  const history = messages.filter((m) => !(m instanceof SystemMessage));
  const response = await chatModel
    .bindTools(WEATHER_TOOLS)
    .invoke([new SystemMessage(WEATHER_AGENT_PROMPT), ...history]);
  return { messages: [response] };
}

async function chatModelNode({ messages }: { messages: BaseMessage[] }) {
  const history = messages.filter((m) => !(m instanceof SystemMessage));
  const response = await chatModel
    .bindTools(ALL_TOOLS)
    .invoke([new SystemMessage(CHAT_AGENT_PROMPT), ...history]);
  return { messages: [response] };
}

async function cryptoModelNode({ messages }: { messages: BaseMessage[] }) {
  const { CRYPTO_AGENT_PROMPT } = await import("@/backend/prompt/system");
  const history = messages.filter((m) => !(m instanceof SystemMessage));
  const response = await chatModel
    .bindTools(CRYPTO_TOOLS)
    .invoke([new SystemMessage(CRYPTO_AGENT_PROMPT), ...history]);
  return { messages: [response] };
}

async function codeModelNode({ messages }: { messages: BaseMessage[] }) {
  const { CODE_AGENT_PROMPT } = await import("@/backend/prompt/system");
  const history = messages.filter((m) => !(m instanceof SystemMessage));
  const response = await chatModel
    .bindTools(CODE_TOOLS)
    .invoke([new SystemMessage(CODE_AGENT_PROMPT), ...history]);
  return { messages: [response] };
}

const weatherToolNode = new ToolNode(WEATHER_TOOLS);
const chatToolNode = new ToolNode(ALL_TOOLS);
const cryptoToolNode = new ToolNode(CRYPTO_TOOLS);
const codeToolNode = new ToolNode(CODE_TOOLS);

// toolsCondition only inspects the last AI message, so its return value is
// independent of what the tool node is named — we just remap "tools" → our
// local node and END → afterAgent.
function weatherRoute(state: { messages: BaseMessage[] }) {
  return toolsCondition(state) === END ? "afterAgent" : "weatherTools";
}
function chatRoute(state: { messages: BaseMessage[] }) {
  return toolsCondition(state) === END ? "afterAgent" : "chatTools";
}
function cryptoRoute(state: { messages: BaseMessage[] }) {
  return toolsCondition(state) === END ? "afterAgent" : "cryptoTools";
}
function codeRoute(state: { messages: BaseMessage[] }) {
  return toolsCondition(state) === END ? "afterAgent" : "codeTools";
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
      .addNode("afterAgent", afterAgentNode)
      .addNode("renameThreadAgent", renameThreadAgentNode)
      .addNode("threadSummarize", threadSummarizeNode)
      // Sequential: START → routerAgent → (weatherModel | chatModel | cryptoModel | codeModel) →
      //   (weatherTools | chatTools | cryptoTools | codeTools)* → afterAgent → threadSummarize → END.
      // ask_location's picker card is owned by the weather model/tool loop
      // (see components/tool-ui/ask-location). ask_crypto_intent's picker
      // card is owned by the crypto loop (see components/tool-ui/crypto).
      // write_code's editor card is owned by the code loop (see components/tool-ui/code).
      .addEdge(START, "routerAgent")
      .addConditionalEdges("routerAgent", routeToSubAgent, {
        weatherAgent: "weatherModel",
        chatAgent: "chatModel",
        cryptoAgent: "cryptoModel",
        codeAgent: "codeModel",
      })
      .addConditionalEdges("weatherModel", weatherRoute, ["weatherTools", "afterAgent"])
      .addEdge("weatherTools", "weatherModel")
      .addConditionalEdges("chatModel", chatRoute, ["chatTools", "afterAgent"])
      .addEdge("chatTools", "chatModel")
      .addConditionalEdges("cryptoModel", cryptoRoute, ["cryptoTools", "afterAgent"])
      .addEdge("cryptoTools", "cryptoModel")
      .addConditionalEdges("codeModel", codeRoute, ["codeTools", "afterAgent"])
      .addEdge("codeTools", "codeModel")
      .addEdge("afterAgent", "threadSummarize")
      .addEdge("threadSummarize", END)
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
// concurrent runs. Concurrent threads cross-mixing in the in-memory
// buffer is a known ceiling — single-dev-session acceptable; revisit
// when we move to prod checkpointing.
const capturingHandler = new CapturingHandler({
  bulkInsert: async (spans) => {
    await bulkInsertSpans(spans);
  },
});

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
