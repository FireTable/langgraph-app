import {
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { SystemMessage, type BaseMessage } from "@langchain/core/messages";

import { chatModel } from "@/backend/model";
import { WEATHER_TOOLS } from "@/backend/tool";
import { WEATHER_AGENT_PROMPT } from "@/backend/prompt/system";

// Weather agent: a focused sub-agent that owns the RAG-style weather
// flow (resolve place → fetch forecast → answer). It re-enters the
// conversation with its own system prompt and a clean message slice
// so the main agent's general-purpose context doesn't leak in.



// Weather sub-agent graph. Runs end-to-end: prepend the weather prompt,
// call the LLM, fan out to the tool node if it produced tool_calls,
// loop until the LLM answers in plain text. Tool results are appended
// to the parent state by LangGraph's normal messages reducer.
async function weatherModelNode({ messages }: { messages: BaseMessage[] }) {
  const system = new SystemMessage(WEATHER_AGENT_PROMPT);

  const response = await chatModel
    .bindTools(WEATHER_TOOLS)
    .invoke([system, ...messages.filter((m) => !(m instanceof SystemMessage))]);


  return { messages: [response] };
}
function shouldContinue({ messages }: { messages: BaseMessage[] }): "tools" | typeof END {
  const last = messages[messages.length - 1];
  const hasToolCalls =
    last != null &&
    "tool_calls" in last &&
    Array.isArray((last as { tool_calls?: unknown }).tool_calls) &&
    (last as { tool_calls: unknown[] }).tool_calls.length > 0;
  return hasToolCalls ? "tools" : END;
}

const weatherToolNode = new ToolNode(WEATHER_TOOLS);

export const weatherSubgraph = new StateGraph(MessagesAnnotation)
  .addNode("model", weatherModelNode)
  .addNode("tools", weatherToolNode)
  .addEdge(START, "model")
  .addConditionalEdges("model", shouldContinue, ["tools", END])
  .addEdge("tools", "model")
  .compile();

// ponytail: kept for the existing tests. Production callers use the
// compiled subgraph via backend/agent.ts.
export async function runWeatherAgent(messages: BaseMessage[]) {
  const result = await weatherSubgraph.invoke({ messages });
  return result.messages;
}
