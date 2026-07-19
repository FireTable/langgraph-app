import { tool, type StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

import { getKbEnv } from "@/lib/kb/env";
import { hybridSearch } from "@/lib/kb/search";
import { extractUserId } from "@/backend/memory/recall";

import { formatSearchResult } from "./format";
import { isPgVectorAvailable } from "./pgvector";
import { thisUserId } from "./user-id";

// ponytail: hybrid RRF over BM25 + pgvector + entity-tag. Returns the
// top-K chunks with `[1] [2] …` markers for the LLM to cite inline.
// Gated on pgvector — a missing extension throws a clear error rather
// than crashing the tool (so the LLM tool surface stays stable).

const searchKbSchema = z.object({
  query: z
    .string()
    .optional()
    .default("")
    .describe(
      "Two modes. (1) Ranked search — pass 5-10 space-separated entries " +
        "(NOT a verbatim copy of the user's question): build from (a) the " +
        "user's question, broken apart (never pass the meta-question " +
        "itself, e.g. 'what is this', 'summarize please', '这是什么', as " +
        "a single entry), and (b) the @-directive label if present " +
        "(split the file/folder name on spaces, dashes, underscores, or " +
        "dots and treat each piece as an entry). Aim for 5-10 entries " +
        "total; fewer is fine if the question is narrow; don't pad with " +
        "repeats or filler. (2) Full scope dump — OMIT query (or pass an " +
        "empty string) when the user wants everything in the filtered " +
        "scope, e.g. 'summarize @doc', 'extract all clauses from @folder', " +
        "'list contents of @doc'. Returns every chunk in documentId, " +
        "every chunk in folderId, or — with no other filter — the user's " +
        "most recent chunks.",
    ),
  folderId: z
    .string()
    .optional()
    .describe(
      "Filter results to documents within this specific folder ID. " +
        "Copy the value verbatim from the ':kb-folder[label]{folderId=...}' " +
        "directive in the user message (optional).",
    ),
  documentId: z
    .string()
    .optional()
    .describe(
      "Filter results to this specific document ID only. " +
        "Copy the value verbatim from the ':kb-document[label]{documentId=...}' " +
        "directive in the user message (optional).",
    ),
});

export const searchKbTool: StructuredTool = tool(
  async ({ query, folderId, documentId }, config) => {
    if (!(await isPgVectorAvailable())) {
      throw new Error("search_kb unavailable: pgvector extension is not installed on the database");
    }
    const userId = extractUserId(config) ?? thisUserId();
    const env = getKbEnv();

    // ponytail: hybridSearch owns the query -> embed -> search
    // pipeline (qvec auto-embedded if not pre-computed; embed
    // failures fall back to the BM25 + tag legs only). Empty query
    // returns the full filtered scope (capped at 1000). When ranked
    // retrieval returns 0 with a scope filter, hybridSearch itself
    // transparently retries with an empty query for the same scope
    // (see "path A fallback" in lib/kb/search.ts).
    const results = await hybridSearch({ userId, query, folderId, documentId });
    return JSON.stringify(formatSearchResult(results, env.chunkMaxChars));
  },
  {
    name: "search_kb",
    description:
      "Search the user's knowledge base (uploaded PDFs / docs) using hybrid " +
      "BM25 + vector + entity-tag retrieval. Returns the most relevant " +
      "chunks with `[1]`, `[2]`, ... markers the LLM can cite inline. Use " +
      "when the user references their KB or asks about content they've uploaded. " +
      "Pass a natural-language query to rank by relevance, OR omit query " +
      "(pass an empty string) to dump the full filtered scope — useful " +
      "for 'summarize @doc', 'extract all clauses from @folder'. " +
      "If the user @-mentioned a doc or folder, narrow the search by copying " +
      "the id from the ':kb-document[label]{documentId=...}' or " +
      "':kb-folder[label]{folderId=...}' directive in the message. " +
      "If results are empty or insufficient, retry with a fresh query " +
      "(rephrased keywords, synonyms, English↔Chinese, or relaxed filters) " +
      "— up to 3 attempts per turn before falling back to search_web.",
    schema: searchKbSchema,
  },
);
