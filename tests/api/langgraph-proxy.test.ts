import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
vi.mock("@/lib/auth/config", () => ({
  auth: { api: { getSession } },
}));

let originalLangchain: string | undefined;
let originalLanggraphUrl: string | undefined;

beforeEach(() => {
  originalLangchain = process.env.LANGCHAIN_API_KEY;
  originalLanggraphUrl = process.env.LANGGRAPH_API_URL;
  process.env.LANGCHAIN_API_KEY = "langchain-test-key";
  process.env.LANGGRAPH_API_URL = "http://localhost:2024";
  fetchMock.mockReset();
  getSession.mockReset();
});

afterEach(() => {
  if (originalLangchain === undefined) delete process.env.LANGCHAIN_API_KEY;
  else process.env.LANGCHAIN_API_KEY = originalLangchain;
  if (originalLanggraphUrl === undefined) delete process.env.LANGGRAPH_API_URL;
  else process.env.LANGGRAPH_API_URL = originalLanggraphUrl;
  vi.resetModules();
});

function makeRequest(
  path: string,
  init: ConstructorParameters<typeof NextRequest>[1] = {},
): NextRequest {
  return new NextRequest(`http://localhost/${path}`, init);
}

const CTX = { params: Promise.resolve({ path: ["threads", "abc"] }) };

describe("withAuth gate on /api/[...path] (LangGraph proxy)", () => {
  it("returns 401 with code:UNAUTHORIZED when the user has no session", async () => {
    getSession.mockResolvedValueOnce(null);
    const { GET } = await import("@/app/api/[..._path]/route");
    const res = await GET(makeRequest("api/threads/abc"), CTX);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proxies GET /api/threads/abc to LangGraph when the user has a session", async () => {
    getSession.mockResolvedValueOnce({
      user: { id: "u1", email: "u1@example.com" },
      session: { id: "s1", userId: "u1" },
    });
    fetchMock.mockResolvedValueOnce(new Response('{"thread_id":"abc"}', { status: 200 }));
    const { GET } = await import("@/app/api/[..._path]/route");
    const res = await GET(makeRequest("api/threads/abc"), CTX);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:2024/threads/abc");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("langchain-test-key");
  });

  it("forwards the user's cookie header to LangGraph", async () => {
    getSession.mockResolvedValueOnce({
      user: { id: "u1", email: "u1@example.com" },
      session: { id: "s1", userId: "u1" },
    });
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const { GET } = await import("@/app/api/[..._path]/route");
    const req = makeRequest("api/threads/abc", {
      headers: { cookie: "better-auth.session_token=abc123" },
    });
    await GET(req, CTX);
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)["cookie"]).toBe(
      "better-auth.session_token=abc123",
    );
  });

  it("streams the upstream SSE body through to the client without buffering", async () => {
    getSession.mockResolvedValueOnce({
      user: { id: "u1", email: "u1@example.com" },
      session: { id: "s1", userId: "u1" },
    });
    // Simulate an SSE stream: a ReadableStream of text/event-stream chunks.
    const sseBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: message\ndata: hi\n\n"));
        controller.enqueue(new TextEncoder().encode("event: end\ndata: bye\n\n"));
        controller.close();
      },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(sseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    const { POST } = await import("@/app/api/[..._path]/route");
    const res = await POST(makeRequest("api/threads/abc/runs/stream"), {
      ...CTX,
      params: Promise.resolve({ path: ["threads", "abc", "runs", "stream"] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    // Body must be a ReadableStream so the runtime can iterate it chunk-by-chunk,
    // not a buffered string. A string body would break streaming entirely.
    expect(res.body).toBeInstanceOf(ReadableStream);
  });
});
