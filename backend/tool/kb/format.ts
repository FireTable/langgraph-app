import type { HybridSearchResult } from "@/lib/kb/search/types";

import type { KbSearchDocument, KbToolResult } from "./types";

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

// ponytail: build the dual-purpose ToolMessage payload. `content` is the
// LLM string with `[1] [2] …` markers; `documents` is the full structured
// rows for the UI. Same data, two views.
//
// Step 1 (audit §11) swapped the input from `HybridSearchResult[]`
// (legacy flat array) to `{ chunks: HybridSearchChunk[] }`. The
// downstream `KbSearchDocument.rrfScore` field is preserved until
// Step 4 lands `scoreKind` in chunk-list.tsx — see the audit's
// P0-3 fix in Step 4.
export function formatSearchResult(
  result: HybridSearchResult,
  chunkMaxChars: number,
): KbToolResult {
  const chunks = result.chunks;
  if (chunks.length === 0) {
    return { content: "", documents: [], empty: true };
  }
  const documents: KbSearchDocument[] = chunks.map((c) => ({
    chunkId: c.chunkId,
    documentId: c.documentId,
    docTitle: c.docTitle,
    pageNumbers: c.pageNumbers,
    content: c.content,
    rrfScore: c.score,
    scoreKind: c.scoreKind,
    legsHit: c.legsHit,
  }));
  // Truncate each chunk to keep the LLM prompt within budget; the full
  // chunk is in `documents` for the UI to fetch if needed.
  let graphSection = "";
  if (result.graphContext) {
    const { entities, relations } = result.graphContext;
    const entStr = entities.map((e) => `- ${e.name} (${e.type}): ${e.description}`).join("\n");
    const relStr = relations
      .map((r) => `- ${r.source} -> ${r.relation} -> ${r.target}: ${r.description}`)
      .join("\n");
    if (entStr || relStr) {
      graphSection = `[Graph Context]\n${entStr ? `Entities:\n${entStr}\n` : ""}${relStr ? `Relations:\n${relStr}\n` : ""}\n`;
    }
  }

  const chunkSection = documents
    .map((d, i) => `[${i + 1}] ${truncate(d.content, chunkMaxChars)}`)
    .join("\n\n");

  const content = graphSection ? `${graphSection}${chunkSection}` : chunkSection;
  return { content, documents, empty: false };
}
