import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
vi.mock("@/lib/auth/config", () => ({
  auth: { api: { getSession } },
}));

function makeRequest(path: string[], body?: string, method = "POST"): Request {
  const url = `http://localhost/api/alchemy/${path.join("/")}`;
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body,
  });
}

let originalKey: string | undefined;

beforeEach(() => {
  originalKey = process.env.ALCHEMY_API_KEY;
  process.env.ALCHEMY_API_KEY = "test-key";
  fetchMock.mockReset();
  getSession.mockReset();
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.ALCHEMY_API_KEY;
  else process.env.ALCHEMY_API_KEY = originalKey;
  vi.resetModules();
});

describe("withAuth gate on /api/alchemy routes", () => {
  it("returns 401 with code:UNAUTHORIZED when the user has no session", async () => {
    getSession.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/alchemy/[...path]/route");
    const res = await POST(
      makeRequest(["eth-mainnet"], '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}'),
      { params: Promise.resolve({ path: ["eth-mainnet"] }) },
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proxies the request when the user has a valid session", async () => {
    getSession.mockResolvedValueOnce({
      user: { id: "u1", email: "u1@example.com" },
      session: { id: "s1", userId: "u1" },
    });
    fetchMock.mockResolvedValueOnce(new Response('{"result":"0x1"}', { status: 200 }));
    const { POST } = await import("@/app/api/alchemy/[...path]/route");
    const res = await POST(makeRequest(["eth-mainnet"], '{"method":"eth_blockNumber"}'), {
      params: Promise.resolve({ path: ["eth-mainnet"] }),
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects unauthenticated calls to /api/alchemy/portfolio/* too", async () => {
    getSession.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/alchemy/[...path]/route");
    const res = await POST(makeRequest(["portfolio", "tokens", "by-address"], "{}"), {
      params: Promise.resolve({ path: ["portfolio", "tokens", "by-address"] }),
    });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated calls to GET /api/alchemy/status", async () => {
    getSession.mockResolvedValueOnce(null);
    const { GET } = await import("@/app/api/alchemy/status/route");
    const res = await GET(new Request("http://localhost/api/alchemy/status"), {
      params: Promise.resolve({} as never),
    });
    expect(res.status).toBe(401);
  });
});
