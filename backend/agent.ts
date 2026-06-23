import { MessagesAnnotation, START, END, StateGraph, Send } from "@langchain/langgraph";
import { callModelNode } from "@/backend/node/call-model-node";
import { renameThreadNode } from "@/backend/node/rename-thread-node";
import { afterAgentNode } from "@/backend/node/after-agent-node";
import { checkpointer } from "@/backend/checkpointer";

// State is just MessagesAnnotation. `title` used to live here, but the
// renameThread node no longer mutates graph state — the title lives in
// the threads DB row and the runtime's generateTitle pulls it from there.
const GraphState = MessagesAnnotation;

// Fan out to `agent` and `renameThread` in parallel from START.
// `afterAgent` runs after `agent` produces its reply and handles
// post-agent side-effects (e.g. bumping `last_message_at`).
const fanOut = (state: typeof GraphState.State) => [
  new Send("agent", state),
  new Send("renameThread", state),
];

export const graph = new StateGraph(GraphState)
  .addNode("agent", callModelNode)
  .addNode("afterAgent", afterAgentNode)
  .addNode("renameThread", renameThreadNode)
  .addConditionalEdges(START, fanOut, ["agent", "renameThread"])
  .addEdge("agent", "afterAgent")
  .addEdge("afterAgent", END)
  .addEdge("renameThread", END)
  .compile({ checkpointer });
