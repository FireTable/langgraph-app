import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// Auth: the route reads session via auth.api.getSession({ headers }).
// Default = logged in so the existing proxy behaviour tests still cover
// the upstream logic; auth.test.ts covers the 401 path.
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

function setEnv(disabled: string | undefined, key: string | undefined) {
  if (disabled === undefined) delete process.env.ALCHEMY_DISABLED_NETWORKS;
  else process.env.ALCHEMY_DISABLED_NETWORKS = disabled;
  if (key === undefined) delete process.env.ALCHEMY_API_KEY;
  else process.env.ALCHEMY_API_KEY = key;
}

let originalDisabled: string | undefined;
let originalKey: string | undefined;

beforeEach(() => {
  originalDisabled = process.env.ALCHEMY_DISABLED_NETWORKS;
  originalKey = process.env.ALCHEMY_API_KEY;
  fetchMock.mockReset();
  getSession.mockReset();
  getSession.mockResolvedValue({
    user: { id: "u1", email: "u1@example.com" },
    session: { id: "s1", userId: "u1" },
  });
});

afterEach(() => {
  setEnv(originalDisabled, originalKey);
  vi.resetModules();
});

describe("POST /api/alchemy/[...path] — allowlist", () => {
  it("returns 400 when the network is not in the catalog at all", async () => {
    setEnv(undefined, "test-key");
    const { POST } = await import("@/app/api/alchemy/[...path]/route");
    const res = await POST(
      makeRequest(["random-network"], '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}'),
      { params: Promise.resolve({ path: ["random-network"] }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not allowed/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 400 when the network is in the catalog but listed in ALCHEMY_DISABLED_NETWORKS", async () => {
    setEnv("eth-mainnet", "test-key");
    const { POST } = await import("@/app/api/alchemy/[...path]/route");
    const res = await POST(
      makeRequest(["eth-mainnet"], '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}'),
      { params: Promise.resolve({ path: ["eth-mainnet"] }) },
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 400 when the path is empty", async () => {
    setEnv(undefined, "test-key");
    const { POST } = await import("@/app/api/alchemy/[...path]/route");
    const res = await POST(makeRequest([], "{}"), {
      params: Promise.resolve({ path: [] }),
    });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/alchemy/[...path] — server config", () => {
  it("returns 500 when ALCHEMY_API_KEY is not set on the server", async () => {
    setEnv(undefined, undefined);
    const { POST } = await import("@/app/api/alchemy/[...path]/route");
    const res = await POST(
      makeRequest(["eth-mainnet"], '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}'),
      { params: Promise.resolve({ path: ["eth-mainnet"] }) },
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/alchemy.*not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/alchemy/[...path] — proxy behavior", () => {
  it("forwards the JSON-RPC body to https://<network>.g.alchemy.com/v2/<key>", async () => {
    setEnv(undefined, "test-key-abc");
    fetchMock.mockResolvedValueOnce(
      new Response('{"jsonrpc":"2.0","id":1,"result":"0x10d4f"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { POST } = await import("@/app/api/alchemy/[...path]/route");
    const body = '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}';
    const res = await POST(makeRequest(["eth-mainnet"], body), {
      params: Promise.resolve({ path: ["eth-mainnet"] }),
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://eth-mainnet.g.alchemy.com/v2/test-key-abc");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(body);
  });

  it("returns the upstream response body + status to the caller", async () => {
    setEnv(undefined, "test-key");
    fetchMock.mockResolvedValueOnce(
      new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}', { status: 200 }),
    );
    const { POST } = await import("@/app/api/alchemy/[...path]/route");
    const res = await POST(
      makeRequest(["polygon-mainnet"], '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}'),
      { params: Promise.resolve({ path: ["polygon-mainnet"] }) },
    );
    expect(res.status).toBe(200);
    const out = await res.text();
    expect(out).toContain('"result":"0x1"');
  });

  it("passes through upstream non-200 statuses (e.g. 429 rate limit)", async () => {
    setEnv(undefined, "test-key");
    fetchMock.mockResolvedValueOnce(
      new Response("rate limited", { status: 429, headers: { "Retry-After": "2" } }),
    );
    const { POST } = await import("@/app/api/alchemy/[...path]/route");
    const res = await POST(makeRequest(["eth-mainnet"], "{}"), {
      params: Promise.resolve({ path: ["eth-mainnet"] }),
    });
    expect(res.status).toBe(429);
  });

  it("attaches CORS headers to the response", async () => {
    setEnv(undefined, "test-key");
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const { POST } = await import("@/app/api/alchemy/[...path]/route");
    const res = await POST(makeRequest(["eth-mainnet"], "{}"), {
      params: Promise.resolve({ path: ["eth-mainnet"] }),
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("GET /api/alchemy/[...path] — healthcheck", () => {
  it("answers OPTIONS preflight with 204 + CORS headers", async () => {
    const { OPTIONS } = await import("@/app/api/alchemy/[...path]/route");
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
