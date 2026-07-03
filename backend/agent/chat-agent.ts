import { END, START, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { SystemMessage, type BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { chatModel } from "@/backend/model";
import { ALL_TOOLS } from "@/backend/tool";
import { CHAT_AGENT_PROMPT } from "@/backend/prompt/system";
import { CommonAgentState } from "@/backend/state";
import { buildSystemMessageWithMemory } from "@/backend/memory/template";

// Chat agent gets every tool — the router already decided whether this
// turn is weather, so chatAgent never sees a weather question. Weather
// tools stay available so chatAgent can answer follow-up turns that
// landed on it for some reason (e.g. the router hiccupped).

// ponytail: buildSystemMessageWithMemory reads userId from the node's
// RunnableConfig (set by the /api proxy in app/api/[..._path]) and
// injects the <memory> block into the system message before model.invoke.
// LangGraph only injects config into the second arg of node functions,
// so dropping config here would silently strip memory for every chat run.
async function chatModelNode({ messages }: { messages: BaseMessage[] }, config?: RunnableConfig) {
  // Strip any stale system messages — bindTools runnables share
  // invocation context, so a previous prompt would leak through.
  const history = messages.filter((m) => !(m instanceof SystemMessage));
  const sysMsg = await buildSystemMessageWithMemory(CHAT_AGENT_PROMPT, config);
  const response = await chatModel.bindTools(ALL_TOOLS).invoke([sysMsg, ...history], config);
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
