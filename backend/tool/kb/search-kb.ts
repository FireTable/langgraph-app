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
      "Space-separated search entries (NOT a verbatim copy of the user's " +
        "question). Build the list by extracting concise entities, keywords, " +
        "and domain terms from TWO sources and concatenating them: (a) the " +
        "user's question — but break the question apart; never pass the " +
        "meta-question itself " +
        "as a single entry, and (b) the @-directive label if one is present " +
        "in the message — split a file/folder name on spaces / dashes / " +
        "underscores / dots and treat each piece as an entry. The hybrid " +
        "search fuses the entries across BM25 (keyword match), vector " +
        "(semantic match), and tag (entity match) legs. Omit (or pass an " +
        "empty string) to return the full content of the filtered scope: " +
        "every chunk in documentId, every chunk in folderId, or — with no " +
        "other filter — the user's most recent chunks.",
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
    // returns the full filtered scope (capped at 1000).
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
      "If the user @-mentioned a doc or folder, narrow the search by copying " +
      "the id from the ':kb-document[label]{documentId=...}' or " +
      "':kb-folder[label]{folderId=...}' directive in the message.",
    schema: searchKbSchema,
  },
);
