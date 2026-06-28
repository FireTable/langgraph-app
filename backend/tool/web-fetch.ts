import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { jinaFetch } from "@/lib/jina";

// ponytail: r.jina.ai/{url} returns markdown for any public page. The whole
// tool is a thin wrapper — keep it that way.

const schema = z.object({
  url: z
    .url()
    .describe(
      "Absolute URL of the page to read (must include scheme, e.g. https://example.com/article).",
    ),
});

async function impl({ url }: { url: string }): Promise<string> {
  const res = await jinaFetch(`https://r.jina.ai/${url}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    // ponytail: jinaFetch already retried 401/403 across the key pool.
    // Anything still failing here is a real upstream problem worth surfacing.
    throw new Error(`fetchUrl ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as {
    data?: { title?: string; content?: string; url?: string };
  };
  return JSON.stringify({
    title: body.data?.title ?? "",
    content: body.data?.content ?? "",
    url: body.data?.url ?? url,
  });
}

export const fetchUrl = tool(impl, {
  name: "fetch_url",
  description:
    "Fetch a public web page and return its content as markdown. Use when the user provides a URL or when a search result warrants reading in full.",
  schema,
});
