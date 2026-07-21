import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  jinaFetch: vi.fn(),
}));

vi.mock("@/lib/jina", () => ({ jinaFetch: mocks.jinaFetch }));

// ponytail: fetchUrlToMarkdown is a thin jina wrapper. Test the
// dispatch shape, not the markdown content (that's jina's problem).

import { fetchUrlToMarkdown } from "@/lib/kb/url";

beforeEach(() => {
  mocks.jinaFetch.mockReset();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchUrlToMarkdown", () => {
  it("calls r.jina.ai with the target URL and returns parsed content", async () => {
    mocks.jinaFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        data: {
          title: "Example Domain",
          content: "Markdown body of the page.",
          url: "https://example.com/",
        },
      }),
    );

    const result = await fetchUrlToMarkdown("https://example.com/");

    expect(mocks.jinaFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = mocks.jinaFetch.mock.calls[0];
    expect(calledUrl).toBe("https://r.jina.ai/https://example.com/");
    expect(calledInit.headers.Accept).toBe("application/json");

    expect(result.title).toBe("Example Domain");
    expect(result.markdown).toBe("Markdown body of the page.");
    expect(result.sourceUrl).toBe("https://example.com/");
  });

  it("returns empty fields when jina response omits data", async () => {
    mocks.jinaFetch.mockResolvedValueOnce(jsonResponse(200, {}));
    const result = await fetchUrlToMarkdown("https://example.com/");
    expect(result.title).toBe("");
    expect(result.markdown).toBe("");
    expect(result.sourceUrl).toBe("https://example.com/");
  });

  it("throws when the upstream returns a non-2xx status", async () => {
    mocks.jinaFetch.mockResolvedValueOnce(jsonResponse(404, { error: "not found" }));
    await expect(fetchUrlToMarkdown("https://missing.example/")).rejects.toThrow(/404/);
  });
});
