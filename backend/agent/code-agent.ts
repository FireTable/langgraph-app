import { END, START, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { SystemMessage, type BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { chatModel } from "@/backend/model";
import { CODE_TOOLS } from "@/backend/tool";
import { CODE_AGENT_PROMPT } from "@/backend/prompt/system";
import { CommonAgentState } from "@/backend/state";
import { buildSystemMessageWithMemory } from "@/backend/memory/template";
import { subgraphCheckpointerConfig } from "@/backend/checkpointer"


// Code sub-agent: model ↔ tools loop. write_code proposes code that
// the user reviews in an editor; execute_code runs it in a Deno
// Deploy Sandbox. CODE_TOOLS is built once at module load in
// backend/tool/index.ts — execute_code is only included when
// DENO_DEPLOY_TOKEN is set, so a missing token degrades gracefully
// (the model can still propose code, just can't run it).
//
// The model ↔ tools loop runs end-to-end inside this subgraph so
// the parent graph never sees the iteration. write_code's editor card
// (components/tool-ui/code) is the user-side approval point.

async function codeModelNode({ messages }: { messages: BaseMessage[] }, config?: RunnableConfig) {
  const messagesWithoutSystem = messages.filter((m) => !(m instanceof SystemMessage));
  const sysMsg = await buildSystemMessageWithMemory(CODE_AGENT_PROMPT, config);
  const response = await chatModel
    .bindTools(CODE_TOOLS)
    .invoke([sysMsg, ...messagesWithoutSystem], config);
  return { messages: [response] };
}

const codeToolNode = new ToolNode(CODE_TOOLS);

const builder = new StateGraph(CommonAgentState)
  .addNode("model", codeModelNode)
  .addNode("tools", codeToolNode)
  .addEdge(START, "model")
  .addConditionalEdges("model", toolsCondition, ["tools", END])
  .addEdge("tools", "model");

export const codeAgent = builder.compile({
  ...subgraphCheckpointerConfig
});
