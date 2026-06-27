import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

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
  fetchMock.mockReset();
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.ALCHEMY_API_KEY;
  else process.env.ALCHEMY_API_KEY = originalKey;
  vi.resetModules();
});

function setKey(k: string | undefined) {
  if (k === undefined) delete process.env.ALCHEMY_API_KEY;
  else process.env.ALCHEMY_API_KEY = k;
}

describe("POST /api/alchemy/portfolio/<endpoint> — Portfolio API proxy", () => {
  it("forwards the body to https://api.g.alchemy.com/data/v1/<key>/<endpoint>", async () => {
    setKey("test-key-xyz");
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { tokens: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { POST } = await import("@/app/api/alchemy/[...path]/route");
    const body = JSON.stringify({
      addresses: [{ address: "0xabc", networks: ["eth-mainnet"] }],
      withMetadata: true,
    });
    const res = await POST(makeRequest(["portfolio", "tokens", "by-address"], body), {
      params: Promise.resolve({ path: ["portfolio", "tokens", "by-address"] }),
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.g.alchemy.com/data/v1/test-key-xyz/assets/tokens/by-address");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(body);
  });

  it("returns 400 when the path after 'portfolio' is empty", async () => {
    setKey("test-key");
    const { POST } = await import("@/app/api/alchemy/[...path]/route");
    const res = await POST(makeRequest(["portfolio"], "{}"), {
      params: Promise.resolve({ path: ["portfolio"] }),
    });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 500 when ALCHEMY_API_KEY is not set on the server", async () => {
    setKey(undefined);
    const { POST } = await import("@/app/api/alchemy/[...path]/route");
    const res = await POST(makeRequest(["portfolio", "tokens", "by-address"], "{}"), {
      params: Promise.resolve({ path: ["portfolio", "tokens", "by-address"] }),
    });
    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes through upstream non-200 statuses (e.g. 429)", async () => {
    setKey("test-key");
    fetchMock.mockResolvedValueOnce(
      new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "2" },
      }),
    );
    const { POST } = await import("@/app/api/alchemy/[...path]/route");
    const res = await POST(makeRequest(["portfolio", "tokens", "by-address"], "{}"), {
      params: Promise.resolve({ path: ["portfolio", "tokens", "by-address"] }),
    });
    expect(res.status).toBe(429);
  });

  it("attaches CORS headers to the response", async () => {
    setKey("test-key");
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const { POST } = await import("@/app/api/alchemy/[...path]/route");
    const res = await POST(makeRequest(["portfolio", "tokens", "by-address"], "{}"), {
      params: Promise.resolve({ path: ["portfolio", "tokens", "by-address"] }),
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("ignores ALCHEMY_DISABLED_NETWORKS for the portfolio branch", async () => {
    process.env.ALCHEMY_DISABLED_NETWORKS = "eth-mainnet,arb-mainnet";
    setKey("test-key");
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const { POST } = await import("@/app/api/alchemy/[...path]/route");
    const res = await POST(makeRequest(["portfolio", "tokens", "by-address"], "{}"), {
      params: Promise.resolve({ path: ["portfolio", "tokens", "by-address"] }),
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
