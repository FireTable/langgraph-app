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
  // "new" = docId freshly generated, needs OCR + chunk + insert.
  // "dedup" = existing docId, skip the heavy pipeline.
  // "failed" = OCR failed (or empty markdown); docId may or may not
  //            exist in DB — resolve layer shows [Failed: ...] for
  //            the file part's kb_ref prefix, or strips the file
  //            part entirely if no docId was ever written.
  // "unknown" = attachment row missing, no docId at all.
  pipelineStatus: "new" | "dedup" | "failed" | "unknown";
  errorMessage: string | null;
};

export const KbAgentState = new StateSchema({
  // From parent — populated by RouterNode at invoke time.
  messages: z.array(z.custom<BaseMessage>()),
  userId: z.string().nullable().default(null),
  // Internal.
  pagesByDocId: z.record(z.string(), z.array(z.custom<PageResult>())).default({}),
  processedFiles: z.array(z.custom<ProcessedFile>()).default([]),
  status: z.enum(["pending", "parsing", "success", "failed"]).default("pending"),
  errorMessage: z.string().nullable().default(null),
});

export type KbAgentStateShape = {
  messages: BaseMessage[];
  userId: string | null;
  pagesByDocId: Record<string, PageResult[]>;
  processedFiles: ProcessedFile[];
  status: "pending" | "parsing" | "success" | "failed";
  errorMessage: string | null;
};
