import {
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { AIMessage, AIMessageChunk, SystemMessage, type BaseMessage } from "@langchain/core/messages";

import { chatModel } from "@/backend/model";
import { WEATHER_TOOLS } from "@/backend/tool";
import { WEATHER_AGENT_PROMPT } from "@/backend/prompt/system";

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

  const response = await chatModel
    .bindTools(WEATHER_TOOLS)
    .invoke([system, ...messages.filter((m) => !(m instanceof SystemMessage))]);


  console.warn(1111111, messages);


  return { messages: [response] };
}

function routeAfterModel({ messages }: { messages: BaseMessage[] }): "tools" | typeof END {
  const last = messages[messages.length - 1];

  const hasToolCalls =
    last != null &&
    (last instanceof AIMessage || last instanceof AIMessageChunk) &&
    Array.isArray(last.tool_calls) &&
    last.tool_calls.length > 0;

  console.warn(2222, last);


  return hasToolCalls ? "tools" : END;
}

const weatherToolNode = new ToolNode(WEATHER_TOOLS);

export const weatherSubgraph = new StateGraph(MessagesAnnotation)
  .addNode("model", weatherModelNode)
  .addNode("tools", weatherToolNode)
  .addEdge(START, "model")
  .addConditionalEdges("model", routeAfterModel, ["tools", END])
  .addEdge("tools", "model")
  .compile();

// ponytail: kept for the existing tests. Production callers use the
// compiled subgraph via backend/agent.ts.
export async function runWeatherAgent(messages: BaseMessage[]) {
  const result = await weatherSubgraph.invoke({ messages });
  return result.messages;
}
