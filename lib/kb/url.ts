import { jinaFetch } from "@/lib/jina";

// ponytail: URL ingest always goes through r.jina.ai — a thin wrapper
// so the KB upload route and the chat fetch_url tool can share one
// implementation. jina handles HTML, SPA, and content negotiation
// server-side; we just parse the JSON response.

export type FetchedPage = {
  title: string;
  markdown: string;
  sourceUrl: string;
};

export async function fetchUrlToMarkdown(url: string): Promise<FetchedPage> {
  const res = await jinaFetch(`https://r.jina.ai/${url}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`fetchUrl ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as {
    data?: { title?: string; content?: string; url?: string };
  };
  return {
    title: body.data?.title ?? "",
    markdown: body.data?.content ?? "",
    sourceUrl: body.data?.url ?? url,
  };
}
