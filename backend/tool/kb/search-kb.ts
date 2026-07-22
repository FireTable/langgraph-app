import { tool, type StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

import { getKbEnv } from "@/lib/kb/env";
import { hybridSearch } from "@/lib/kb/search/index";
import { extractUserId } from "@/backend/memory/recall";

import { formatSearchResult } from "./format";
import { isPgVectorAvailable } from "./pgvector";
import { thisUserId } from "./user-id";

// ponytail: hybrid RRF over BM25 + pgvector + entity-tag. Returns the
// top-K chunks with `[1] [2] …` markers for the LLM to cite inline.
// Gated on pgvector — a missing extension throws a clear error rather
// than crashing the tool (so the LLM tool surface stays stable).
//
// Step 1 (audit §11 + §2 / §2b): the LLM-facing schema is now
//   rewriteQuery   — natural-language query (NOT a keyword soup)
//   originalQuery  — verbatim user message, drives a second dense
//                    sub-leg (multi-query / RAG-Fusion)
//   entities       — specific named terms → tag leg
//   themes         — high-level topics → tag leg
//   folderId / documentId — scope filter
// The describe shrank from ~15 lines to ~3 because the responsibilities
// are split across fields (P0-2 fix). All retrieval params (qvec /
// entryTopK / chunkTopK) live inside the orchestrator and never reach
// the tool (audit §3).

const searchKbSchema = z.object({
  rewriteQuery: z
    .string()
    .optional()
    .default("")
    .describe(
      "Natural-language query (NOT a keyword soup). Pass a clean, " +
        "complete sentence that re-states what you want — even when the " +
        "user's message is short or context-dependent. Omit (or pass '') " +
        "to dump the full filtered scope (e.g. 'summarize @doc').",
    ),
  originalQuery: z
    .string()
    .optional()
    .describe(
      "Verbatim user message, when it's short or relies on prior " +
        "context. Drives a second dense sub-leg for multi-query fusion. " +
        "Safe to omit; falls back to rewriteQuery alone.",
    ),
  entities: z
    .array(z.string())
    .optional()
    .describe(
      "Specific named terms the user mentioned (people, products, " +
        "companies, abbreviations). Used by the tag leg for exact match.",
    ),
  themes: z
    .array(z.string())
    .optional()
    .describe(
      "High-level topics / intents (e.g. 'pricing', 'onboarding', " +
        "'architecture'). Used by the tag leg alongside entities.",
    ),
  folderId: z
    .string()
    .optional()
    .describe(
      "Filter to this folder ID. Copy from the " + "':kb-folder[label]{folderId=...}' directive.",
    ),
  documentId: z
    .string()
    .optional()
    .describe(
      "Filter to this document ID only. Copy from the " +
        "':kb-document[label]{documentId=...}' directive.",
    ),
});

export const searchKbTool: StructuredTool = tool(
  async ({ rewriteQuery, originalQuery, entities, themes, folderId, documentId }, config) => {
    if (!(await isPgVectorAvailable())) {
      throw new Error("search_KB unavailable: pgvector extension is not installed on the database");
    }
    const userId = extractUserId(config) ?? thisUserId();
    const env = getKbEnv();

    // ponytail: hybridSearch owns the query -> embed -> search
    // pipeline. Empty rewriteQuery returns the full filtered scope
    // (capped at 1000). originalQuery feeds a second dense sub-leg
    // when present (multi-query fusion, audit §2b). entities/themes
    // feed the tag leg.
    const result = await hybridSearch({
      userId,
      rewriteQuery,
      originalQuery,
      entities,
      themes,
      scope: { folderId, documentId },
    });
    return JSON.stringify(formatSearchResult(result, env.chunkMaxChars));
  },
  {
    name: "search_KB",
    description:
      "Search the user's knowledge base (uploaded PDFs / docs) using hybrid " +
      "BM25 + vector + entity-tag retrieval. Returns the most relevant " +
      "chunks with `[1]`, `[2]`, ... markers the LLM can cite inline. Use " +
      "when the user references their KB or asks about content they've uploaded. " +
      "Pass a natural-language `rewriteQuery` to rank by relevance; fill `entities` " +
      "and `themes` with the named terms and topics you read from the message; " +
      "fill `originalQuery` with the verbatim user message when it's short or " +
      "context-dependent (multi-query fusion). OR omit `rewriteQuery` to dump " +
      "the full filtered scope — useful for 'summarize @doc', 'extract all " +
      "clauses from @folder'. If the user @-mentioned a doc or folder, narrow " +
      "by copying the id from the `:kb-document[label]{documentId=...}` or " +
      "`:kb-folder[label]{folderId=...}` directive. If results are empty or " +
      "insufficient, retry with a fresh query — up to 3 attempts per turn " +
      "before falling back to search_web.",
    schema: searchKbSchema,
  },
);
