import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { fetchUrl } from "@/backend/tool/web-fetch";

const jinaFetchMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/jina", () => ({ jinaFetch: jinaFetchMock }));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  jinaFetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchUrl", () => {
  it("calls r.jina.ai with the target URL and returns parsed content", async () => {
    jinaFetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: {
          title: "Example Domain",
          content: "Markdown body of the page.",
          url: "https://example.com/",
        },
      }),
    );

    const result = await fetchUrl.invoke({ url: "https://example.com/" });

    expect(jinaFetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = jinaFetchMock.mock.calls[0];
    expect(calledUrl).toBe("https://r.jina.ai/https://example.com/");
    expect(calledInit.headers.Accept).toBe("application/json");

    const parsed = JSON.parse(result as string);
    expect(parsed.title).toBe("Example Domain");
    expect(parsed.content).toBe("Markdown body of the page.");
    expect(parsed.url).toBe("https://example.com/");
  });

  it("rejects non-URL input via schema validation", async () => {
    await expect(fetchUrl.invoke({ url: "not a url" })).rejects.toThrow();
    expect(jinaFetchMock).not.toHaveBeenCalled();
  });

  it("throws when the upstream returns a non-2xx status", async () => {
    jinaFetchMock.mockResolvedValueOnce(jsonResponse(404, { error: "not found" }));
    await expect(fetchUrl.invoke({ url: "https://missing.example/" })).rejects.toThrow(/404/);
  });
});
