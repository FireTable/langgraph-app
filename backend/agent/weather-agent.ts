import { END, START, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { chatModel } from "@/backend/model";
import { WEATHER_TOOLS } from "@/backend/tool";
import { WEATHER_AGENT_PROMPT } from "@/backend/prompt/system";
import { CommonAgentState } from "@/backend/state";

// Weather agent: a focused sub-agent that owns the RAG-style weather
// flow (resolve place → fetch forecast → answer). The whole flow
// lives inside the subgraph so the parent graph doesn't need to
// know that weather turns invoke a picker card.

// Weather sub-agent graph. Runs end-to-end: prepend the weather prompt,
// call the LLM, fan out to the tool node if it produced tool_calls.
// ask_location is a pure trigger — its sentinel ToolMessage is what
// the frontend card keys on, and the user's pick comes back as an
// overwritten tool result on the next model pass.
async function weatherModelNode({ messages }: { messages: BaseMessage[] }) {
  const system = new SystemMessage(WEATHER_AGENT_PROMPT);

  const messagesWithoutSystem = messages.filter((m) => !(m instanceof SystemMessage));

  const response = await chatModel
    .bindTools(WEATHER_TOOLS)
    .invoke([system, ...messagesWithoutSystem]);

  return { messages: [response] };
}

const weatherToolNode = new ToolNode(WEATHER_TOOLS);

const builder = new StateGraph(CommonAgentState)
    .addNode("model", weatherModelNode)
    .addNode("tools", weatherToolNode)
    .addEdge(START, "model")
    .addConditionalEdges("model", toolsCondition, ["tools", END])
    .addEdge("tools", "model")

export const weatherAgent = builder.compile();
