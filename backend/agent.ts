import { MessagesAnnotation, START, END, StateGraph, Annotation } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { SystemMessage, type BaseMessage } from "@langchain/core/messages";

import { chatModel } from "@/backend/model";
import { ALL_TOOLS } from "@/backend/tool";
import { renameThreadAgentNode } from "@/backend/node/rename-thread-agent-node";
import { afterAgentNode } from "@/backend/node/after-agent-node";
import { weatherSubgraph } from "@/backend/node/weather-agent-node";
import { routerAgentNode } from "@/backend/node/router-agent-node";
import { CHAT_AGENT_PROMPT } from "@/backend/prompt/system";
import { checkpointer } from "@/backend/checkpointer";

// routerDecision is set by routerAgentNode (zod-validated) and read by
// routeToSubAgent to pick the next sub-agent. No reducer — each
// turn rewrites it. No downstream node reads it, so it's not exposed
// outside the router/edge pair.
const GraphState = Annotation.Root({
  ...MessagesAnnotation.spec,
  routerDecision: Annotation<{ next: "weatherAgent" | "chatAgent" } | undefined>(),
});

// chatAgent gets every tool — the router already decided whether this
// turn is weather, so chatAgent never sees a weather question. Weather
// tools stay available so chatAgent can answer follow-up turns that
// landed on it for some reason (e.g. the router hiccupped).
const chatModelWithTools = chatModel.bindTools(ALL_TOOLS);
const toolNode = new ToolNode(ALL_TOOLS);

async function chatAgentNode({ messages }: { messages: BaseMessage[] }) {
  // Strip any stale system messages — bindTools runnables share
  // invocation context, so a previous prompt would leak through.
  const history = messages.filter((m) => !(m instanceof SystemMessage));
  const response = await chatModelWithTools.invoke([new SystemMessage(CHAT_AGENT_PROMPT), ...history]);
  return { messages: [response] };
}

export function shouldCallTool({ messages }: { messages: BaseMessage[] }): "tools" | "afterAgent" {
  const last = messages[messages.length - 1];
  const hasToolCalls =
    last != null &&
    "tool_calls" in last &&
    Array.isArray((last as { tool_calls?: unknown }).tool_calls) &&
    (last as { tool_calls: unknown[] }).tool_calls.length > 0;
  return hasToolCalls ? "tools" : "afterAgent";
}

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


// ponytail: no blanket tool gating. Read tools (searchWeb, fetchUrl) run
// unconditionally. Write tools added later should hang their own node
// off chatAgent → toolNode loop and pass `interruptBefore: ["<that-node>"]`
// to `compile()` so only the write path pauses for approval.
export const graph = new StateGraph(GraphState)
  .addNode("routerAgent", routerAgentNode)
  .addNode("chatAgent", chatAgentNode)
  .addNode("tools", toolNode)
  .addNode("afterAgent", afterAgentNode)
  .addNode("renameThreadAgent", renameThreadAgentNode)
  .addNode("weatherAgent", weatherSubgraph)
  // Sequential: START → routerAgent → (weatherAgent | chatAgent) → afterAgent → END.
  // ask_location's picker card is owned by the weather subgraph
  // (see backend/node/weather-agent-node.ts + components/tool-ui/ask-location).
  // renameThreadAgent is wired off START so its DB side-effect runs in
  // parallel without touching the messages channel.
  .addEdge(START, "routerAgent")
  .addConditionalEdges("routerAgent", routeToSubAgent, ["weatherAgent", "chatAgent"])
  .addConditionalEdges("chatAgent", shouldCallTool, ["tools", "afterAgent"])
  .addEdge("tools", "chatAgent")
  .addEdge("weatherAgent", "afterAgent")
  .addEdge("afterAgent", END)
  .addEdge(START, "renameThreadAgent")
  .addEdge("renameThreadAgent", END)
  .compile({ checkpointer });
