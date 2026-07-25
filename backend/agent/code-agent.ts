import { END, START, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import type { BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { getChatModel } from "@/backend/model";
import { CODE_TOOLS } from "@/backend/tool";
import { CODE_AGENT_PROMPT } from "@/backend/prompt/system";
import { CommonAgentState } from "@/backend/state";
import {
  buildSystemMessageWithMemory,
  loadThreadSummariesForPrompt,
  prepareMessagesForInvoke,
} from "@/backend/memory/template";
import { extractUserId } from "@/backend/memory/recall";
import { subgraphCheckpointerConfig } from "@/backend/checkpointer";

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

import { getAgentPrompt } from "@/backend/prompt/loader";

async function codeModelNode({ messages }: { messages: BaseMessage[] }, config?: RunnableConfig) {
  const threads = await loadThreadSummariesForPrompt(config);
  const userId = extractUserId(config) ?? undefined;
  const history = await prepareMessagesForInvoke(messages, threads?.summaries ?? [], userId);
  const promptInfo = await getAgentPrompt("codeAgent", userId);
  const sysMsg = await buildSystemMessageWithMemory(promptInfo.content, config, threads);

  const response = await (
    await getChatModel()
  )
    .bindTools(CODE_TOOLS)
    .invoke([sysMsg, ...history], config);
  return { messages: [response] };
}

function codeModelRoute(state: { messages: BaseMessage[] }) {
  return toolsCondition(state) === END ? END : "codeTools";
}

const codeToolNode = new ToolNode(CODE_TOOLS);

const builder = new StateGraph(CommonAgentState)
  .addNode("codeModel", codeModelNode)
  .addNode("codeTools", codeToolNode)
  .addEdge(START, "codeModel")
  .addConditionalEdges("codeModel", codeModelRoute, ["codeTools", END])
  .addEdge("codeTools", "codeModel");

export const codeAgent = builder.compile({
  ...subgraphCheckpointerConfig,
});
