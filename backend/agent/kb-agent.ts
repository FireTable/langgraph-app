import { END, START, StateGraph } from "@langchain/langgraph";
import { checkpointer, subgraphCheckpointerConfig } from "@/backend/checkpointer";
import { capturingHandler, creditTrackingHandler } from "@/backend/callbacks";
import { KbAgentState, type KbAgentStateShape } from "@/backend/state";
import { store } from "@/backend/store";
import {
  prepareKBDataNode,
  splitFileToPageNode,
  pageToMarkdownNode,
  rewriteMessagesNode,
  entityExtractNode,
  entityAlignmentNode,
  entityEmbedNode,
} from "@/backend/node/kb";
import type { RunnableConfig } from "@langchain/core/runnables";

// ponytail: chunksEmbedAgent is a SUB-graph that owns the
// entity extraction → alignment → embedding chain. Parent kbAgent
// hangs it as a single node, so by construction the three inner
// steps run in declared order with no race: entityExtractNode
// awaits its per-doc IIFE completion before returning, so
// entityAlignmentNode sees the rows in kb_entity /
// kb_relationship, and entityEmbedNode gets the canonical graph
// already aligned.
//
// Audit §3 "kbAgent 拆 3 个 node" still holds — these three
// remain DISTINCT inner nodes of the sub-graph; the parent
// collapse to one node is about the parent's edges, not the
// audit-level decomposition.
//
// chat path never enters this sub-graph. Chat routing bypasses
// kbAgent's ingestion chain and reads via the /api/kb/documents
// or scopeDump fallback.

export const chunksEmbedAgent = new StateGraph(KbAgentState)
  .addNode("entityExtract", entityExtractNode)
  .addNode("entityAlignment", entityAlignmentNode)
  .addNode("entityEmbed", entityEmbedNode)
  .addEdge(START, "entityExtract")
  .addEdge("entityExtract", "entityAlignment")
  .addEdge("entityAlignment", "entityEmbed")
  .addEdge("entityEmbed", END)
  .compile();

function routeAfterRewrite(state: KbAgentStateShape, config: RunnableConfig): string | typeof END {
  const hasNew = state.processedFiles.some((p) => p.pipelineStatus === "new");
  // ponytail: chat-upload path skips chunksEmbedAgent — the doc's
  // OCR data is captured (prepareKBData → splitFilePage →
  // pageToMarkdown → rewriteMessages), but the expensive entity /
  // alignment / embedding step waits for an explicit user action
  // from the KB page (POST /api/kb/documents/[id]/reprocess with
  // source="kb-reprocess"). This keeps chat replies instant; the
  // ingestion cost (LLM extract + 1024-dim embedding batches) is
  // only paid when the user actually commits the doc to the
  // knowledge graph. Anyone reading this guard: don't try to
  // "parallelize" by routing to chunksEmbedAgent AND returning END
  // — LangGraph conditional edges are mutually exclusive. The
  // manual trigger is wired at
  // app/api/kb/documents/[id]/reprocess/route.ts:117.

  const waitingForChunksEmbed = (config.configurable?.source ?? "chat") !== "chat";
  console.log(
    `[kbAgent] routeAfterRewrite: waitingForChunksEmbed=${waitingForChunksEmbed} hasNew=${hasNew}, files=`,
    state.processedFiles.map((p) => ({ docId: p.docId, status: p.pipelineStatus })),
  );
  if (hasNew && waitingForChunksEmbed) {
    console.log(`[kbAgent] Routing to chunksEmbedAgent`);
    return "chunksEmbedAgent";
  }
  console.log(`[kbAgent] Routing to END`);
  return END;
}

const builder = new StateGraph(KbAgentState)
  .addNode("prepareKBData", prepareKBDataNode)
  .addNode("splitFilePage", splitFileToPageNode)
  .addNode("pageToMarkdown", pageToMarkdownNode)
  .addNode("rewriteMessages", rewriteMessagesNode)
  .addNode("chunksEmbedAgent", chunksEmbedAgent)
  .addEdge(START, "prepareKBData")
  .addEdge("prepareKBData", "splitFilePage")
  .addEdge("splitFilePage", "pageToMarkdown")
  .addEdge("pageToMarkdown", "rewriteMessages")
  .addConditionalEdges("rewriteMessages", routeAfterRewrite, {
    chunksEmbedAgent: "chunksEmbedAgent",
    __end__: END,
  })
  .addEdge("chunksEmbedAgent", END);

export const kbAgent = builder.compile({
  name: "kbAgent",
  ...subgraphCheckpointerConfig,
});

const standaloneCompiled = builder.compile({
  name: "kbAgent",
  checkpointer,
  store,
});

type WithConfigPregel = (config: Record<string, unknown>) => typeof standaloneCompiled;
export const graph = (standaloneCompiled.withConfig as unknown as WithConfigPregel)({
  callbacks: [capturingHandler, creditTrackingHandler],
});
