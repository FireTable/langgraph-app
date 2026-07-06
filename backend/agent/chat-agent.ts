import { END, START, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { SystemMessage, type BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { chatModel } from "@/backend/model";
import { ALL_TOOLS } from "@/backend/tool";
import { CHAT_AGENT_PROMPT } from "@/backend/prompt/system";
import { CommonAgentState } from "@/backend/state";
import {
  buildSystemMessageWithMemory,
  type ThreadSummariesPayload,
} from "@/backend/memory/template";
import { extractThreadId, extractUserId } from "@/backend/memory/recall";
import { getThreadSummaries } from "@/lib/memory/queries";
import { subgraphCheckpointerConfig } from "@/backend/checkpointer";

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
  // Strip any stale system messages — bindTools runnables share
  // invocation context, so a previous prompt would leak through.
  const history = messages.filter((m) => !(m instanceof SystemMessage));

  const threads = await loadThreadSummariesForPrompt(config);
  const sysMsg = await buildSystemMessageWithMemory(CHAT_AGENT_PROMPT, config, threads);
  const response = await chatModel.bindTools(ALL_TOOLS).invoke([sysMsg, ...history], config);

  return { messages: [response] };
}

// ponytail: lift the store read for the current thread's compressed
// history into a tiny helper so the node function reads as the clean
// intent ("build the prompt, then invoke"), not "build the prompt
// with three Promise.all args and a ternary". Failures are swallowed
// (empty payload) — a degraded prompt that loses compressed history
// is better than a chat that 500s on store flake.
async function loadThreadSummariesForPrompt(
  config?: RunnableConfig,
): Promise<ThreadSummariesPayload | null> {
  const userId = extractUserId(config);
  const threadId = extractThreadId(config);
  if (!userId || !threadId) return null;
  try {
    const all = await getThreadSummaries(userId, threadId);
    if (all.length === 0) return null;
    return {
      threadId,
      summaries: all
        .sort((a: { sequence: number }, b: { sequence: number }) => a.sequence - b.sequence)
        .map(
          (s: {
            sequence: number;
            summary: string;
            startMessageIndex: number;
            endMessageIndex: number;
            triggerReason: "turn_based" | "token_based";
            tokenCountBefore: number;
            tokenCountAfter: number;
            createdAt: string;
          }) => ({
            sequence: s.sequence,
            summary: s.summary,
            startMessageIndex: s.startMessageIndex,
            endMessageIndex: s.endMessageIndex,
            triggerReason: s.triggerReason,
            tokenCountBefore: s.tokenCountBefore,
            tokenCountAfter: s.tokenCountAfter,
            createdAt: s.createdAt,
          }),
        ),
    };
  } catch {
    return null;
  }
}

// toolsCondition returns END for the no-tool path; that END becomes the
// subgraph's exit point and the parent routes chatAgent → afterAgent.
function chatModelRoute(state: { messages: BaseMessage[] }) {
  return toolsCondition(state) === END ? END : "tools";
}

const chatToolNode = new ToolNode(ALL_TOOLS);

const builder = new StateGraph(CommonAgentState)
  .addNode("model", chatModelNode)
  .addNode("tools", chatToolNode)
  .addEdge(START, "model")
  .addConditionalEdges("model", chatModelRoute, ["tools", END])
  .addEdge("tools", "model");

export const chatAgent = builder.compile({
  ...subgraphCheckpointerConfig,
});
