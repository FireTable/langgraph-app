import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { searchWeb } from "@/backend/tool/web-search";

// searchWeb is `StructuredTool | null` — lazy-registered on JINA_API_KEYS.
// Tests assume the key is set; bind a non-null reference here so the rest of
// the file doesn't repeat `!` and tsc narrows correctly.
const webSearch =
  searchWeb ??
  (() => {
    throw new Error("searchWeb is null — set JINA_API_KEYS to run these tests");
  })();

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("searchWeb", () => {
  it("calls s.jina.ai with the query and returns parsed results", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          { title: "First result", url: "https://a.example/", description: "snippet A" },
          { title: "Second result", url: "https://b.example/", description: "snippet B" },
        ],
      }),
    );

    const result = await webSearch.invoke({ query: "openai ceo" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe("https://s.jina.ai/openai%20ceo");
    expect(calledInit.headers.Authorization).toMatch(/^Bearer /);

    const parsed = JSON.parse(result as string);
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[0]).toMatchObject({
      title: "First result",
      url: "https://a.example/",
      description: "snippet A",
    });
  });

  it("rejects empty query", async () => {
    await expect(webSearch.invoke({ query: "" })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when upstream returns a non-2xx status", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: "down" }));
    await expect(webSearch.invoke({ query: "anything" })).rejects.toThrow(/500/);
  });
});
