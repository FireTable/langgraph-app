import type { HybridSearchResult } from "@/lib/kb/search";

import type { KbSearchDocument, KbToolResult } from "./types";

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

// ponytail: build the dual-purpose ToolMessage payload. `content` is the
// LLM string with `[1] [2] …` markers; `documents` is the full structured
// rows for the UI. Same data, two views.
export function formatSearchResult(
  results: HybridSearchResult[],
  chunkMaxChars: number,
): KbToolResult {
  if (results.length === 0) {
    return { content: "", documents: [], empty: true };
  }
  const documents: KbSearchDocument[] = results.map((r) => ({
    chunkId: r.chunkId,
    documentId: r.documentId,
    docTitle: r.docTitle,
    pageNumbers: r.pageNumbers,
    content: r.content,
    rrfScore: r.rrfScore,
    legsHit: r.legsHit,
  }));
  // Truncate each chunk to keep the LLM prompt within budget; the full
  // chunk is in `documents` for the UI to fetch if needed.
  const content = documents
    .map((d, i) => `[${i + 1}] ${truncate(d.content, chunkMaxChars)}`)
    .join("\n\n");
  return { content, documents, empty: false };
}
