import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { jinaFetch } from "@/lib/jina";

// ponytail: s.jina.ai/{query} is a search endpoint — same auth surface as
// the reader, so the key pool is shared via jinaFetch.

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

export const searchWeb = tool(impl, {
  name: "searchWeb",
  description:
    "Search the web for a keyword or natural-language query and return the top results with title, URL, and snippet. Use this when the user asks a question that needs current or external information.",
  schema,
});
