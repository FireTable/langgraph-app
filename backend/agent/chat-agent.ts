import { END, START, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { chatModel } from "@/backend/model";
import { ALL_TOOLS } from "@/backend/tool";
import { CHAT_AGENT_PROMPT } from "@/backend/prompt/system";
import { CommonAgentState } from "@/backend/state";

// Chat agent gets every tool — the router already decided whether this
// turn is weather, so chatAgent never sees a weather question. Weather
// tools stay available so chatAgent can answer follow-up turns that
// landed on it for some reason (e.g. the router hiccupped).

async function chatModelNode({ messages }: { messages: BaseMessage[] }) {
  // Strip any stale system messages — bindTools runnables share
  // invocation context, so a previous prompt would leak through.
  const history = messages.filter((m) => !(m instanceof SystemMessage));
  const response = await chatModel
    .bindTools(ALL_TOOLS)
    .invoke([new SystemMessage(CHAT_AGENT_PROMPT), ...history]);
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
  .addEdge("tools", "model")

export const chatAgent = builder.compile();
