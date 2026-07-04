// ponytail: background graph owns EVERY turn-end side-effect that is
// NOT on the chat response edge. Today that's two things:
//
//   1. touch `threads.last_message_at` — was afterAgentNode's job, kept
//      here so thread list ordering updates without inflating chat
//      invoke() latency.
//
//   2. compress a window of human turns into a SummaryEntry — was
//      threadSummarizeNode's job; a `summarize` node now hosts the
//      same function behind the same gating logic.
//
// Built as a proper StateGraph (not the functional-API `entrypoint`
// we tried first) because langgraphjs dev loads graphs from
// langgraph.json the same way it loads the chat graph — and the
// functional API doesn't register cleanly through that path. With
// addNode + addEdge + START/END the topology is explicit and matches
// the sub-agent pattern in backend/agent/chat-agent.ts (reusing
// CommonAgentState for the messages-only state shape).
//
// userId / threadId ride on the runtime config (configurable), not
// on state — same convention as the chat graph. Each node pulls them
// off config.configurable; the chat graph forwards them via
// `backgroundGraph.invoke(input, { configurable })` from
// backend/node/schedule-background-node.ts.
import { START, END, StateGraph } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";

import { checkpointer } from "@/backend/checkpointer";
import { CommonAgentState } from "@/backend/state";
import { store } from "@/backend/store";
import { threadSummarizeNode } from "@/backend/node/thread-summarize-node";
import { touchLastMessageAt } from "@/lib/threads/queries";
import { capturingHandler } from "@/backend/callbacks";

// ponytail: separate file → easier to mock in tests. Each node follows
// the same shape as the sub-agent nodes (in backend/agent/chat-agent.ts
// etc.): take state + config, return a partial state update.

export async function touchLastMessageNode(
  _state: { messages: BaseMessage[] },
  config: { configurable?: { thread_id?: unknown } },
): Promise<{ messages: BaseMessage[] }> {
  const threadId = config.configurable?.thread_id;
  if (typeof threadId === "string" && threadId.length > 0) {
    await touchLastMessageAt(threadId);
  }
  // Empty state update — the messages reducer on CommonAgentState would
  // turn `[]` into a no-op (no replace, no add). Same side-effect-only
  // contract as the original afterAgentNode.
  return { messages: [] };
}


const builder = new StateGraph(CommonAgentState)
  .addNode("touchLastMessage", touchLastMessageNode)
  .addNode("summarize", threadSummarizeNode)
  // ponytail: linear — both side-effects run every invoke. Cheap to
  // skip later if `summarize` becomes a bottleneck (e.g. add a
  // shouldSummarizeRouter conditional edge between the two nodes);
  // for the MVP feasibility test the simple linear shape matches
  // what the chat graph used to do sequentially inside afterAgent's
  // superstep.
  .addEdge(START, "touchLastMessage")
  .addEdge("touchLastMessage", "summarize")
  .addEdge("summarize", END);

// ponytail: compiling here (not in agent.ts) keeps the checkpointer /
// store wiring local to this graph — the chat graph has its own
// compile({...}) call. Both compile into their own Pregel instance;
// langgraphjs dev loads both from langgraph.json.
const compiled = builder.compile({ checkpointer, store });

// ponytail: same withConfig cast pattern as backend/agent.ts — Pregel's
// `withConfig` has two overloads (Runnable vs PregelOptions) and TS
// can't pick for a bare callbacks object.
type WithConfigPregel = (config: Record<string, unknown>) => typeof compiled;
export const graph = (compiled.withConfig as unknown as WithConfigPregel)({
  callbacks: [capturingHandler],
});
