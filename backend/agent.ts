import { START, END, StateGraph } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";

import { renameThreadAgentNode } from "@/backend/node/rename-thread-agent-node";
import { afterAgentNode } from "@/backend/node/after-agent-node";
import { weatherAgent } from "@/backend/agent/weather-agent";
import { chatAgent } from "@/backend/agent/chat-agent";
import { routerAgentNode } from "@/backend/node/router-agent-node";
import { checkpointer } from "@/backend/checkpointer";
import { RouterAgentState } from "@/backend/state";

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

// Wrapper nodes: RouterAgentState has `messages` + `routerDecision`, but
// the sub-agents only know `messages`. Pattern A from the LangGraph
// subgraph docs — different schemas, explicit transform at the seam.
async function runChatAgent({ messages }: { messages: BaseMessage[] }) {
  const output = await chatAgent.invoke({ messages });
  return { messages: output.messages };
}

async function runWeatherAgent({ messages }: { messages: BaseMessage[] }) {
  const output = await weatherAgent.invoke({ messages });
  return { messages: output.messages };
}

export const graph = new StateGraph(RouterAgentState)
  .addNode("routerAgent", routerAgentNode)
  .addNode("chatAgent", runChatAgent)
  .addNode("afterAgent", afterAgentNode)
  .addNode("renameThreadAgent", renameThreadAgentNode)
  .addNode("weatherAgent", runWeatherAgent)
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
  .compile({ checkpointer });
