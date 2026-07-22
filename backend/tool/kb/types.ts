import type { HybridSearchResult } from "@/lib/kb/search/types";
import type { LegHit } from "@/lib/kb/search/types";

// ponytail: ToolMessage shape returned by every KB search tool. Both
// fields describe the SAME payload from two perspectives:
//   - `content`  — the LLM-facing string with `[1] [2] …` markers baked
//                 in. The model emits inline citations by copying these.
//                 Community consensus (LangChain / LlamaIndex / Haystack):
//                 hide scores from the LLM, use them only for ranking.
//   - `documents` — the UI-facing structured array for Sources cards.
//                   Carries `rrfScore` + `legsHit` so the frontend can
//                   show debug badges.
//
// Step 1 (audit §4 / §11): `legsHit` now mirrors the frozen `LegHit`
// enum (7 values, including the B-phase `"rel" | "entity" | "graph"`
// placeholders). The UI only renders A-phase values today; widening
// the type here means Step 6 doesn't need a wire-format change.
export type KbSearchDocument = {
  chunkId: string;
  documentId: string;
  docTitle: string;
  pageNumbers: number[];
  content: string;
  rrfScore: number;
  scoreKind: "rrf" | "rerank";
  legsHit: LegHit[];
};

export type KbToolResult = {
  content: string;
  documents: KbSearchDocument[];
  empty: boolean;
};

// ponytail: `list_documents` returns a folder-grouped shape so the
// chat-side card can render each folder as a collapsible section and
// the LLM can see the folder structure in `content`. `documents[]`
// carries the same per-doc status counts (totalPages / successPages /
// totalChunks / …) that the Settings → KB DocStatusBadge +
// ChunksStatusBadge read — same source of truth for both surfaces.

export type ListDocumentsArgs = {
  folderId?: string;
  status?: "success" | "failed" | "parsing" | "pending";
  titleQuery?: string;
  page?: number;
  pageSize?: number;
};

export type ListDocumentsDoc = {
  id: string;
  title: string;
  status: "success" | "failed" | "parsing" | "pending";
  errorMessage: string | null;
  createdAt: string;
  totalPages: number;
  successPages: number;
  failedPages: number;
  parsingPages: number;
  pendingPages: number;
  totalChunks: number;
  successChunks: number;
  failedChunks: number;
  pendingChunks: number;
  parsingChunks: number;
};

export type ListDocumentsFolder = {
  id: string;
  name: string;
  documents: ListDocumentsDoc[];
};

export type ListDocumentsResult = {
  folders: ListDocumentsFolder[];
  total: number;
  page: number;
  pageSize: number;
};

export type { HybridSearchResult };
