import type { KbDocument } from "@/lib/kb/schema";
import type { HybridSearchResult } from "@/lib/kb/search";

// ponytail: ToolMessage shape returned by every KB search tool. Both
// fields describe the SAME payload from two perspectives:
//   - `content`  — the LLM-facing string with `[1] [2] …` markers baked
//                 in. The model emits inline citations by copying these.
//                 Community consensus (LangChain / LlamaIndex / Haystack):
//                 hide scores from the LLM, use them only for ranking.
//   - `documents` — the UI-facing structured array for Sources cards.
//                   Carries `rrfScore` + `legsHit` so the frontend can
//                   show debug badges.

export type KbSearchDocument = {
  chunkId: string;
  documentId: string;
  docTitle: string;
  pageNumbers: number[];
  content: string;
  rrfScore: number;
  legsHit: Array<"kw" | "vec" | "tag">;
};

export type KbToolResult = {
  content: string;
  documents: KbSearchDocument[];
  empty: boolean;
};

// ponytail: `list_documents` returns a thin shape — no chunk rows, just
// the document metadata the LLM needs to decide what to do next. The
// UI's `mention=1` API and the Settings → KB tab both build richer
// shapes from the same table.

export type ListDocumentsArgs = {
  folderId?: string;
  status?: "success" | "failed" | "parsing" | "pending";
  titleQuery?: string;
  page?: number;
  pageSize?: number;
};

export type ListDocumentsResult = {
  documents: KbDocument[];
  total: number;
  page: number;
  pageSize: number;
};

export type { HybridSearchResult };
