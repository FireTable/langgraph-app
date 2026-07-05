import { END, START, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { SystemMessage, type BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { chatModel } from "@/backend/model";
import { CRYPTO_TOOLS } from "@/backend/tool";
import { CRYPTO_AGENT_PROMPT } from "@/backend/prompt/system";
import { CommonAgentState } from "@/backend/state";
import { buildSystemMessageWithMemory } from "@/backend/memory/template";
import { subgraphCheckpointerConfig } from "@/backend/checkpointer";

// Crypto sub-agent: mirrors the weather subgraph. The model ↔ tools
// loop runs end-to-end inside the subgraph so the parent graph doesn't
// need to know that crypto turns invoke a human-in-the-loop card.
// ask_crypto_intent is a pure trigger — its sentinel ToolMessage is
// what the frontend card keys on, and the user's pick comes back as
// an overwritten tool result on the next model pass.

async function cryptoModelNode({ messages }: { messages: BaseMessage[] }, config?: RunnableConfig) {
  const messagesWithoutSystem = messages.filter((m) => !(m instanceof SystemMessage));
  const sysMsg = await buildSystemMessageWithMemory(CRYPTO_AGENT_PROMPT, config);
  const response = await chatModel
    .bindTools(CRYPTO_TOOLS)
    .invoke([sysMsg, ...messagesWithoutSystem], config);
  return { messages: [response] };
}

const cryptoToolNode = new ToolNode(CRYPTO_TOOLS);

const builder = new StateGraph(CommonAgentState)
  .addNode("model", cryptoModelNode)
  .addNode("tools", cryptoToolNode)
  .addEdge(START, "model")
  .addConditionalEdges("model", toolsCondition, ["tools", END])
  .addEdge("tools", "model");

export const cryptoAgent = builder.compile({
  ...subgraphCheckpointerConfig,
});
