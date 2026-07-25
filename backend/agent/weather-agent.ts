import { END, START, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import type { BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { getChatModel } from "@/backend/model";
import { WEATHER_TOOLS } from "@/backend/tool";
import { WEATHER_AGENT_PROMPT } from "@/backend/prompt/system";
import { CommonAgentState } from "@/backend/state";
import {
  buildSystemMessageWithMemory,
  loadThreadSummariesForPrompt,
  prepareMessagesForInvoke,
} from "@/backend/memory/template";
import { extractUserId } from "@/backend/memory/recall";
import { subgraphCheckpointerConfig } from "@/backend/checkpointer";

// Weather agent: a focused sub-agent that owns the RAG-style weather
// flow (resolve place → fetch forecast → answer). The whole flow
// lives inside the subgraph so the parent graph doesn't need to
// know that weather turns invoke a picker card.

// Weather sub-agent graph. Runs end-to-end: prepend the weather prompt,
// call the LLM, fan out to the tool node if it produced tool_calls.
// ask_location is a pure trigger — its sentinel ToolMessage is what
// the frontend card keys on, and the user's pick comes back as an
// overwritten tool result on the next model pass.
import { getAgentPrompt } from "@/backend/prompt/loader";

async function weatherModelNode(
  { messages }: { messages: BaseMessage[] },
  config?: RunnableConfig,
) {
  const threads = await loadThreadSummariesForPrompt(config);
  const userId = extractUserId(config) ?? undefined;
  const history = await prepareMessagesForInvoke(messages, threads?.summaries ?? [], userId);
  const promptInfo = await getAgentPrompt("weatherAgent", userId);
  const sysMsg = await buildSystemMessageWithMemory(promptInfo.content, config, threads);

  const response = await (
    await getChatModel()
  )
    .bindTools(WEATHER_TOOLS)
    .invoke([sysMsg, ...history], config);

  return { messages: [response] };
}

function weatherModelRoute(state: { messages: BaseMessage[] }) {
  return toolsCondition(state) === END ? END : "weatherTools";
}

const weatherToolNode = new ToolNode(WEATHER_TOOLS);

const builder = new StateGraph(CommonAgentState)
  .addNode("weatherModel", weatherModelNode)
  .addNode("weatherTools", weatherToolNode)
  .addEdge(START, "weatherModel")
  .addConditionalEdges("weatherModel", weatherModelRoute, ["weatherTools", END])
  .addEdge("weatherTools", "weatherModel");

export const weatherAgent = builder.compile({
  ...subgraphCheckpointerConfig,
});
