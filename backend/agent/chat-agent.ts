import { END, START, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { SystemMessage, type BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { chatModel } from "@/backend/model";
import { ALL_TOOLS } from "@/backend/tool";
import { CHAT_AGENT_PROMPT } from "@/backend/prompt/system";
import { CommonAgentState } from "@/backend/state";

// Chat agent gets every tool — the router already decided whether this
// turn is weather, so chatAgent never sees a weather question. Weather
// tools stay available so chatAgent can answer follow-up turns that
// landed on it for some reason (e.g. the router hiccupped).

// ponytail: the withMemoryRecall Proxy on chatModel reads userId from
// `options.configurable.userId` — LangGraph only injects it into the
// graph config the proxy route sets, so we MUST pass the node's
// RunnableConfig through to model.invoke. Dropping config here was the
// bug that left recall a no-op for every chat run (verified via
// /tmp/memory-recall-trace.log: 6 invokes, 0 userIds).
async function chatModelNode({ messages }: { messages: BaseMessage[] }, config?: RunnableConfig) {
  // Strip any stale system messages — bindTools runnables share
  // invocation context, so a previous prompt would leak through.
  const history = messages.filter((m) => !(m instanceof SystemMessage));
  const response = await chatModel
    .bindTools(ALL_TOOLS)
    .invoke([new SystemMessage(CHAT_AGENT_PROMPT), ...history], config);
  return { messages: [response] };
}

// toolsCondition returns END for the no-tool path; that END becomes the
// subgraph's exit point and the parent routes chatAgent → afterAgent.
function chatModelRoute(state: { messages: BaseMessage[] }) {
  return toolsCondition(state) === END ? END : "tools";
}

const chatToolNode = new ToolNode(ALL_TOOLS);

const builder = new StateGraph(CommonAgentState)
  .addNode("model", chatModelNode)
  .addNode("tools", chatToolNode)
  .addEdge(START, "model")
  .addConditionalEdges("model", chatModelRoute, ["tools", END])
  .addEdge("tools", "model");

export const chatAgent = builder.compile();
