import { MessagesAnnotation, START, END, StateGraph, Send } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { BaseMessage } from "@langchain/core/messages";

import { chatModel } from "@/backend/model";
import { TOOLS } from "@/backend/tool";
import { renameThreadNode } from "@/backend/node/rename-thread-node";
import { afterAgentNode } from "@/backend/node/after-agent-node";
import { checkpointer } from "@/backend/checkpointer";

const GraphState = MessagesAnnotation;

// Bind tools onto the chat model once at module load. The bound runnable
// shares the underlying HTTP pool of the base chat model.
const chatModelWithTools = chatModel.bindTools(TOOLS);

const toolNode = new ToolNode(TOOLS);

async function agentNode({ messages }: { messages: BaseMessage[] }) {
  const response = await chatModelWithTools.invoke(messages);
  return { messages: [response] };
}

// ponytail: toolsCondition returns END for "no tool calls", but we want
// afterAgent to run on that branch, so route it ourselves.
export function routeAfterAgent({ messages }: { messages: BaseMessage[] }): "tools" | "afterAgent" {
  const last = messages[messages.length - 1];
  const hasToolCalls =
    last != null &&
    "tool_calls" in last &&
    Array.isArray((last as { tool_calls?: unknown }).tool_calls) &&
    (last as { tool_calls: unknown[] }).tool_calls.length > 0;
  return hasToolCalls ? "tools" : "afterAgent";
}

// Fan out to `agent` and `renameThread` in parallel from START.
// `afterAgent` runs after `agent` produces its reply and handles
// post-agent side-effects (e.g. bumping `last_message_at`).
const fanOut = (state: typeof GraphState.State) => [
  new Send("agent", state),
  new Send("renameThread", state),
];

// ponytail: no blanket tool gating. Read tools (searchWeb, fetchUrl) run
// unconditionally. Write tools added later should hang their own node
// off the agent → toolNode loop and pass `interruptBefore: ["<that-node>"]`
// to `compile()` so only the write path pauses for approval.
export const graph = new StateGraph(GraphState)
  .addNode("agent", agentNode)
  .addNode("tools", toolNode)
  .addNode("afterAgent", afterAgentNode)
  .addNode("renameThread", renameThreadNode)
  .addConditionalEdges(START, fanOut, ["agent", "renameThread"])
  .addConditionalEdges("agent", routeAfterAgent, ["tools", "afterAgent"])
  .addEdge("tools", "agent")
  .addEdge("afterAgent", END)
  .addEdge("renameThread", END)
  .compile({ checkpointer });
