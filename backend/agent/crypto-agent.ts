import { END, START, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import type { BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { chatModel } from "@/backend/model";
import { CRYPTO_TOOLS } from "@/backend/tool";
import { CRYPTO_AGENT_PROMPT } from "@/backend/prompt/system";
import { CommonAgentState } from "@/backend/state";
import {
  buildSystemMessageWithMemory,
  loadThreadSummariesForPrompt,
  trimMessagesForInvoke,
} from "@/backend/memory/template";
import { subgraphCheckpointerConfig } from "@/backend/checkpointer";
import { inlineFileData } from "@/lib/langgraph/inline-file-data";

// Crypto sub-agent: mirrors the weather subgraph. The model ↔ tools
// loop runs end-to-end inside the subgraph so the parent graph doesn't
// need to know that crypto turns invoke a human-in-the-loop card.
// ask_crypto_intent is a pure trigger — its sentinel ToolMessage is
// what the frontend card keys on, and the user's pick comes back as an
// overwritten tool result on the next model pass.

async function cryptoModelNode({ messages }: { messages: BaseMessage[] }, config?: RunnableConfig) {
  // ponytail: same load+trim pattern as chatAgent — read the
  // thread's compressed history, inject as <earlier_conversation>,
  // and drop the original turns from the input array. state.messages
  // is NEVER touched.
  const threads = await loadThreadSummariesForPrompt(config);
  const history = trimMessagesForInvoke(messages, threads?.summaries ?? []);
  // File URLs → base64 inlining (see lib/langgraph/inline-file-data.ts).
  // Without it, a PDF on the human turn would 400 the same way
  // chat-agent did.
  const inlined = await inlineFileData(history);
  const sysMsg = await buildSystemMessageWithMemory(CRYPTO_AGENT_PROMPT, config, threads);
  const response = await chatModel.bindTools(CRYPTO_TOOLS).invoke([sysMsg, ...inlined], config);
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
