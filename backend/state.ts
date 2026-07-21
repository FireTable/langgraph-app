import { z } from "zod";
import { StateSchema, MessagesValue } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";

import type { FilePart } from "@/lib/kb/extract";

// ponytail: userMessageCount is *not* on RouterAgentState because
// deriving it from state.messages in the summarize node (one filter
// over a list of a few hundred messages) is cheaper than threading
// a counter through every model node return. Cost is at most O(N)
// once per N user-message thresholds — well below the rate the chat
// hits `afterAgent`.
export const RouterAgentState = new StateSchema({
  messages: MessagesValue,
  routerDecision: z.object({
    next: z.enum(["weatherAgent", "chatAgent", "cryptoAgent", "codeAgent", "kbAgent"]),
  }),
});

export const CommonAgentState = new StateSchema({
  messages: MessagesValue,
});

// ---------------------------------------------------------------------------
// KB ingest subgraph state
// ---------------------------------------------------------------------------

export type PageResult = {
  pageIndex: number;
  imageUrl: string;
  markdown: string;
  /** Native text extracted from the PDF text layer by mupdf. Empty for scanned/image-only pages. */
  referenceText?: string;
  // ponytail: structured text blocks with bboxes, populated by the PDF
  // handler from mupdf's structured-text walk. The OCR prompt uses
  // these to tell the LLM where each paragraph sits on the page so it
  // can correlate inline images with captions / surrounding context.
  // Empty when the page has no text layer (scanned PDFs).
  textBlocks?: Array<{ text: string; bbox: [number, number, number, number] }>;
  // ponytail: pre-uploaded R2 URLs for every embedded raster image on
  // this page, plus its placement bbox. The OCR prompt lists these so
  // the vision LLM can reference real image URLs in its markdown
  // output instead of hallucinating them. Same page-indexed naming
  // convention as Office (`img-p{N}-{idx}`) so the keys are stable
  // across re-ingests of the same source.
  imageRefs?: Array<{
    name: string;
    url: string;
    bbox: [number, number, number, number];
    width: number;
    height: number;
  }>;
  errorMessage?: string;
  // ponytail: per-page 4-stage status mirroring kbChunkStatusEnum.
  // Written by pageToMarkdownNode when OCR succeeds/fails; pending
  // is the default for a freshly-screenshot page whose markdown
  // hasn't been produced yet. Legacy rows (no status field) read as
  // "success" when markdown is non-empty, "failed" when errorMessage
  // is set, "pending" when both are empty — preserves existing UI
  // behaviour for docs ingested before this field existed.
  status?: "pending" | "parsing" | "success" | "failed";
};

// Per-file record. One entry per PDF file part found across every
// HumanMessage. Drives every node — prepareKBDataNode fills it,
// splitFileToPageNode uploads images + extracts reference text,
// pageToMarkdownNode updates page markdown, rewriteMessagesNode
// uses it to rewrite HumanMessages. filePart.data is the join key
// when matching back to the original HumanMessage content.
export type ProcessedFile = {
  messageIndex: number;
  filePart: FilePart;
  docId: string | null;
  attachmentId: string | null;
  r2Key: string | null;
  title: string | null;
  contentHash: string | null;
  // ponytail: source mime_type copied from attachment.contentType at
  // prepareKBDataNode time. splitFileToPageNode reads this to dispatch
  // via getIngestHandler() — pdf vs markdown vs plain vs image all
  // share the same orchestrator but take different code paths.
  contentType: string | null;
  // "new" = docId freshly generated, needs OCR + chunk + insert.
  // "dedup" = existing docId, skip the heavy pipeline.
  // "failed" = OCR failed (or empty markdown); docId may or may not
  //            exist in DB — resolve layer shows [Failed: ...] for
  //            the file part's kb_ref prefix, or strips the file
  //            part entirely if no docId was ever written.
  // "unknown" = attachment row missing, no docId at all.
  pipelineStatus: "new" | "dedup" | "failed" | "unknown";
  errorMessage: string | null;
  // ponytail: when pipelineStatus === "dedup", this is the row's
  // CURRENT status read from the kb_documents table at dispatch time.
  // kbAgent's terminal node (`rewriteMessagesNode`) writes this back
  // to the row so a previous kbAgent run that landed `success` is
  // visible to the user even when the dispatch path went through a
  // re-upload dedup short-circuit. Optional for the `new` / `failed`
  // / `unknown` branches that produce their own row status.
  existingStatus?: "pending" | "parsing" | "success" | "failed";
};

export const KbAgentState = new StateSchema({
  // From parent — populated by RouterNode at invoke time.
  messages: z.array(z.custom<BaseMessage>()),
  userId: z.string().nullable().default(null),
  // ponytail: "full" = original OCR + chunk + embed pipeline.
  // "chunksOnly" = skip the OCR chain (prepareKBData reads an
  // existing doc row whose pages[].markdown is reused) — only the
  // chunk + embed + entity stage lands. Populated by
  // `fireIngestionRun` from `config.configurable` when invoked by
  // `POST /api/kb/documents/[id]/reprocess?chunksOnly=true`. The
  // kb_documents row stays at its terminal status (no reset).
  mode: z.enum(["full", "chunksOnly", "retryFailed", "retryFailedChunks"]).default("full"),
  // ponytail: for chunksOnly dispatch, this is the target docId
  // (the row whose pages[].markdown will be re-chunked). Ignored in
  // full mode (prepareKBData figures the docId out per file part).
  docId: z.string().nullable().default(null),
  // Internal.
  pagesByDocId: z.record(z.string(), z.array(z.custom<PageResult>())).default({}),
  processedFiles: z.array(z.custom<ProcessedFile>()).default([]),
  status: z.enum(["pending", "parsing", "success", "failed"]).default("pending"),
  errorMessage: z.string().nullable().default(null),
});

export type KbAgentStateShape = {
  messages: BaseMessage[];
  userId: string | null;
  mode: "full" | "chunksOnly" | "retryFailed" | "retryFailedChunks";
  docId: string | null;
  pagesByDocId: Record<string, PageResult[]>;
  processedFiles: ProcessedFile[];
  status: "pending" | "parsing" | "success" | "failed";
  errorMessage: string | null;
};
