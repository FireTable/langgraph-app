import { START, END, StateGraph } from "@langchain/langgraph";

import { renameThreadAgentNode } from "@/backend/node/rename-thread-agent-node";
import { afterAgentNode } from "@/backend/node/after-agent-node";
import { weatherSubgraph } from "@/backend/agent/weather-agent";
import { chatSubgraph } from "@/backend/agent/chat-agent";
import { routerAgentNode } from "@/backend/node/router-agent-node";
import { checkpointer } from "@/backend/checkpointer";
import { GraphState } from "@/backend/state";

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

export const graph = new StateGraph(GraphState)
  .addNode("routerAgent", routerAgentNode)
  .addNode("chatAgent", chatSubgraph)
  .addNode("afterAgent", afterAgentNode)
  .addNode("renameThreadAgent", renameThreadAgentNode)
  .addNode("weatherAgent", weatherSubgraph)
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
