import { tool, type StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

import { getKbEnv } from "@/lib/kb/env";
import { hybridSearch } from "@/lib/kb/search";

import { formatSearchResult } from "./format";
import { isPgVectorAvailable } from "./pgvector";
import { thisUserId } from "./user-id";

// ponytail: same machinery as search_kb, but biases the entity-tag
// leg. We split the query into entities (length≥3 word tokens) and
// pass them as `qents` so the tag leg dominates the fused ranking.
// Falls back to a normal hybrid search when no entities parse out.

const searchGraphSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "Entity name or phrase to search the knowledge graph for. Use when " +
        "the user asks about specific entities, relationships between docs, " +
        "or multi-hop questions ('who acquired X', 'what orgs mention Y').",
    ),
  topK: z.number().int().min(1).optional(),
});

export const searchGraphTool: StructuredTool = tool(
  async ({ query, topK }) => {
    if (!(await isPgVectorAvailable())) {
      throw new Error(
        "search_graph unavailable: pgvector extension is not installed on the database",
      );
    }
    const env = getKbEnv();
    const qents = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w: string) => w.length >= 3);
    const results = await hybridSearch({
      userId: thisUserId(),
      query,
      qents: qents.length > 0 ? qents : undefined,
      topK,
    });
    return JSON.stringify(formatSearchResult(results, env.chunkMaxChars));
  },
  {
    name: "search_graph",
    description:
      "Traverse the user's knowledge graph by entity name. Use for " +
      "multi-hop questions, entity-relationship queries, or whenever the " +
      "user names a specific org/person/concept. Backed by the same " +
      "hybrid RRF as search_kb but biases toward the entity-tag leg.",
    schema: searchGraphSchema,
  },
);
