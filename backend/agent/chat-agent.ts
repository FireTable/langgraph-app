import { END, START, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import type { BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { getChatModel } from "@/backend/model";
import { ALL_TOOLS } from "@/backend/tool";
import { CHAT_AGENT_PROMPT } from "@/backend/prompt/system";
import { CommonAgentState } from "@/backend/state";
import {
  buildSystemMessageWithMemory,
  loadThreadSummariesForPrompt,
  trimMessagesForInvoke,
} from "@/backend/memory/template";
import { subgraphCheckpointerConfig } from "@/backend/checkpointer";
import { attachmentKbInjectorNode } from "@/backend/node/attachment-kb-injector-node";

// Chat agent gets every tool — the router already decided whether this
// turn is weather, so chatAgent never sees a weather question. Weather
// tools stay available so chatAgent can answer follow-up turns that
// landed on it for some reason (e.g. the router hiccupped).

// ponytail: buildSystemMessageWithMemory reads userId + threadId from
// the node's RunnableConfig (set by the /api proxy in
// app/api/[..._path]) and injects the <memory> + <threads> blocks into
// the system message before model.invoke. LangGraph only injects
// config into the second arg of node functions, so dropping config
// here would silently strip both blocks for every chat run.
//
// <threads> carries threadSummarizeNode's compression output: the
// Q&A history of THIS thread (not cross-thread), read from the store
// at invoke time. Surface this every turn so the model has continuity
// even when state.messages only shows the most recent few turns.
async function chatModelNode({ messages }: { messages: BaseMessage[] }, config?: RunnableConfig) {
  // ponytail: summaries must be loaded BEFORE trimming — the trim
  // depends on max(endMessageIndex). The model reads older turns via
  // the <earlier_conversation> block in its SystemMessage, so cutting
  // them out of the input array is a token-cost move (not a
  // context-loss one). state.messages is NEVER touched — UI +
  // checkpointer read from it directly.
  const threads = await loadThreadSummariesForPrompt(config);
  const history = trimMessagesForInvoke(messages, threads?.summaries ?? []);

  const sysMsg = await buildSystemMessageWithMemory(CHAT_AGENT_PROMPT, config, threads);
  const response = await (
    await getChatModel()
  )
    .bindTools(ALL_TOOLS)
    .invoke([sysMsg, ...history], config);

  return { messages: [response] };
}

function chatModelRoute(state: { messages: BaseMessage[] }) {
  return toolsCondition(state) === END ? END : "chatTools";
}

const chatToolNode = new ToolNode(ALL_TOOLS);

const builder = new StateGraph(CommonAgentState)
  .addNode("injectAttachments", attachmentKbInjectorNode)
  .addNode("chatModel", chatModelNode)
  .addNode("chatTools", chatToolNode)
  // ponytail: the injector runs once per chat subgraph invocation,
  // BEFORE chatModelNode. It is a no-op when the latest user message
  // has no PDF file parts (every existing chat turn today). The KB
  // rewrite of state.messages (file part → text content) only
  // happens when a PDF is present, so the existing chat history
  // replay path is unchanged for non-PDF messages.
  .addEdge(START, "injectAttachments")
  .addEdge("injectAttachments", "chatModel")
  .addConditionalEdges("chatModel", chatModelRoute, ["chatTools", END])
  .addEdge("chatTools", "chatModel");

export const chatAgent = builder.compile({
  ...subgraphCheckpointerConfig,
});
