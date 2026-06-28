import { tool, type StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

import { hasKeys, jinaFetch } from "@/lib/jina";

// ponytail: s.jina.ai/{query} requires a key. The tool is only
// registered when JINA_API_KEYS is non-empty, so the model never sees
// a search tool that would 401 on every call.

const schema = z.object({
  query: z
    .string()
    .min(1)
    .describe("Natural-language search query, e.g. 'who is the ceo of openai'."),
});

async function impl({ query }: { query: string }): Promise<string> {
  const res = await jinaFetch(`https://s.jina.ai/${encodeURIComponent(query)}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`searchWeb ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as {
    data?: Array<{ title?: string; url?: string; description?: string }>;
  };
  const results = (body.data ?? []).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    description: r.description ?? "",
  }));
  return JSON.stringify({ query, results });
}

export const searchWeb: StructuredTool | null = hasKeys()
  ? tool(impl, {
      name: "search_web",
      description:
        "Search the web for a keyword or natural-language query and return the top results with title, URL, and snippet. Use this when the user asks a question that needs current or external information.",
      schema,
    })
  : null;
