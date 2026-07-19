import { tool, type StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

import { getKbEnv } from "@/lib/kb/env";
import { hybridSearch } from "@/lib/kb/search";
import { getEmbeddingModel } from "@/backend/model";
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
    .min(1)
    .describe(
      "Natural-language query about the user's knowledge base. " +
        "Use when the user asks about uploaded PDFs, prior research, or " +
        "anything that may be in their KB.",
    ),
  topK: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "How many chunks to return. Defaults to KB_HYBRID_TOPK_DEFAULT " +
        "(usually 8). Capped at KB_HYBRID_TOPK_MAX.",
    ),
});

export const searchKbTool: StructuredTool = tool(
  async ({ query, topK }, config) => {
    if (!(await isPgVectorAvailable())) {
      throw new Error("search_kb unavailable: pgvector extension is not installed on the database");
    }
    const userId = extractUserId(config) ?? thisUserId();
    const env = getKbEnv();

    let qvec: number[] | null = null;
    try {
      const embedder = await getEmbeddingModel();
      qvec = await embedder.embedQuery(query);
    } catch (err) {
      console.warn("[search_kb] Failed to embed query, falling back to non-vector legs:", err);
    }

    const results = await hybridSearch({ userId, query, qvec, topK });
    return JSON.stringify(formatSearchResult(results, env.chunkMaxChars));
  },
  {
    name: "search_kb",
    description:
      "Search the user's knowledge base (uploaded PDFs / docs) using hybrid " +
      "BM25 + vector + entity-tag retrieval. Returns the top-k most relevant " +
      "chunks with `[1]`, `[2]`, ... markers the LLM can cite inline. Use " +
      "when the user references their KB or asks about content they've uploaded.",
    schema: searchKbSchema,
  },
);
