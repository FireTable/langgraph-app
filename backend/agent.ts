import { START, END, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { renameThreadAgentNode } from "@/backend/node/rename-thread-agent-node";
import { afterAgentNode } from "@/backend/node/after-agent-node";
import { weatherAgent } from "@/backend/agent/weather-agent";
import { chatAgent } from "@/backend/agent/chat-agent";
import { routerAgentNode } from "@/backend/node/router-agent-node";
import { checkpointer } from "@/backend/checkpointer";
import { RouterAgentState } from "@/backend/state";
import { chatModel } from "@/backend/model";
import { ALL_TOOLS, WEATHER_TOOLS } from "@/backend/tool";
import { CHAT_AGENT_PROMPT, WEATHER_AGENT_PROMPT } from "@/backend/prompt/system";

// USE_SUBGRAPH=true switches the compiled graph between two topologies.
// Default (false / unset): inlined — flatten weather/chat model+tool loops
// into the parent graph. This is the safe workaround for the
// EventStreamCallbackHandler "Run ID not found in run map" bug that
// LangGraph JS subgraphs trigger under @langchain/core@1.2.1.
// See memory/langgraph-subgraph-run-map-bug.md.
// Set USE_SUBGRAPH=true to use the compiled weatherAgent / chatAgent
// subgraphs instead. Both topologies are kept in this file in sync —
// if you change a model, prompt, or tool set, update both builders.
const USE_SUBGRAPH = process.env.USE_SUBGRAPH === "true" || process.env.USE_SUBGRAPH === "1";

// After the router speaks, decide which sub-agent gets the turn.
// Falls back to chatAgent if the router hasn't run yet or its
// decision didn't make it into state.
function routeToSubAgent({
  routerDecision,
}: {
  routerDecision?: { next: "weatherAgent" | "chatAgent" };
}): "weatherAgent" | "chatAgent" {
  return routerDecision?.next ?? "chatAgent";
}

// ---------------------------------------------------------------------------
// Subgraph version — preferred when the upstream run-map bug is fixed.
// Reads the two compiled subgraphs and wires them as opaque nodes.
// ---------------------------------------------------------------------------
function buildSubgraph() {
  return (
    new StateGraph(RouterAgentState)
      .addNode("routerAgent", routerAgentNode)
      .addNode("chatAgent", chatAgent)
      .addNode("afterAgent", afterAgentNode)
      .addNode("renameThreadAgent", renameThreadAgentNode)
      .addNode("weatherAgent", weatherAgent)
      // Sequential: START → routerAgent → (weatherAgent | chatAgent) → afterAgent → END.
      // ask_location's picker card is owned by the weather subgraph
      // (see backend/agent/weather-agent.ts + components/tool-ui/ask-location).
      // renameThreadAgent is wired off START so its DB side-effect runs in
      // parallel without touching the messages channel.
      .addEdge(START, "routerAgent")
      .addConditionalEdges("routerAgent", routeToSubAgent, ["weatherAgent", "chatAgent"])
      .addEdge("chatAgent", "afterAgent")
      .addEdge("weatherAgent", "afterAgent")
      .addEdge("afterAgent", END)
      .addEdge(START, "renameThreadAgent")
      .addEdge("renameThreadAgent", END)
  );
}

// ---------------------------------------------------------------------------
// Inlined version (default) — flatten weather-agent.ts + chat-agent.ts
// model/tool loops into the parent graph. Keep in sync with those files.
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

const weatherToolNode = new ToolNode(WEATHER_TOOLS);
const chatToolNode = new ToolNode(ALL_TOOLS);

// toolsCondition only inspects the last AI message, so its return value is
// independent of what the tool node is named — we just remap "tools" → our
// local node and END → afterAgent.
function weatherRoute(state: { messages: BaseMessage[] }) {
  return toolsCondition(state) === END ? "afterAgent" : "weatherTools";
}
function chatRoute(state: { messages: BaseMessage[] }) {
  return toolsCondition(state) === END ? "afterAgent" : "chatTools";
}

function buildInlined() {
  return (
    new StateGraph(RouterAgentState)
      .addNode("routerAgent", routerAgentNode)
      .addNode("weatherModel", weatherModelNode)
      .addNode("weatherTools", weatherToolNode)
      .addNode("chatModel", chatModelNode)
      .addNode("chatTools", chatToolNode)
      .addNode("afterAgent", afterAgentNode)
      .addNode("renameThreadAgent", renameThreadAgentNode)
      // Sequential: START → routerAgent → (weatherModel | chatModel) →
      //   (weatherTools | chatTools)* → afterAgent → END.
      // ask_location's picker card is owned by the weather model/tool loop
      // (see components/tool-ui/ask-location).
      .addEdge(START, "routerAgent")
      .addConditionalEdges("routerAgent", routeToSubAgent, {
        weatherAgent: "weatherModel",
        chatAgent: "chatModel",
      })
      .addConditionalEdges("weatherModel", weatherRoute, ["weatherTools", "afterAgent"])
      .addEdge("weatherTools", "weatherModel")
      .addConditionalEdges("chatModel", chatRoute, ["chatTools", "afterAgent"])
      .addEdge("chatTools", "chatModel")
      .addEdge("afterAgent", END)
      .addEdge(START, "renameThreadAgent")
      .addEdge("renameThreadAgent", END)
  );
}

const builder = USE_SUBGRAPH ? buildSubgraph() : buildInlined();

// Exported for the topology smoke test (tests/backend/agent-topologies.test.ts).
// Don't use these directly in app code — go through `graph`.
export { buildSubgraph, buildInlined };

export const graph = builder.compile({ checkpointer });
