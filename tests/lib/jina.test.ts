import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { parseKeys, pickKey, markBad, poolSize, jinaFetch, _resetForTests } from "@/lib/jina";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  _resetForTests(undefined);
});

describe("parseKeys", () => {
  it("returns [] for undefined", () => {
    expect(parseKeys(undefined)).toEqual([]);
  });

  it("returns [] for empty string", () => {
    expect(parseKeys("")).toEqual([]);
  });

  it("parses a single key", () => {
    expect(parseKeys("k1")).toEqual(["k1"]);
  });

  it("parses comma-separated keys", () => {
    expect(parseKeys("k1,k2,k3")).toEqual(["k1", "k2", "k3"]);
  });

  it("trims whitespace and drops empty segments", () => {
    expect(parseKeys(" k1 , k2 ,, k3 ")).toEqual(["k1", "k2", "k3"]);
  });
});

describe("pickKey / markBad / poolSize", () => {
  it("throws when pool is empty", () => {
    _resetForTests(undefined);
    expect(() => pickKey()).toThrow("JINA_API_KEYS is empty");
  });

  it("returns the only key when pool has one", () => {
    _resetForTests("only");
    expect(pickKey()).toBe("only");
  });

  it("returns one of the configured keys", () => {
    _resetForTests("a,b,c");
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(pickKey());
    expect(seen).toEqual(new Set(["a", "b", "c"]));
  });

  it("markBad removes the key", () => {
    _resetForTests("a,b");
    markBad("a");
    expect(poolSize()).toBe(1);
    expect(pickKey()).toBe("b");
  });

  it("markBad is a no-op for unknown key", () => {
    _resetForTests("a,b");
    markBad("zzz");
    expect(poolSize()).toBe(2);
  });
});

describe("jinaFetch", () => {
  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("returns the response on 2xx", async () => {
    _resetForTests("k1");
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const res = await jinaFetch("https://r.jina.ai/u");
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer k1");
  });

  it("merges caller-provided headers alongside Authorization", async () => {
    _resetForTests("k1");
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await jinaFetch("https://r.jina.ai/u", { headers: { "X-Trace": "t1" } });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer k1");
    expect(init.headers["X-Trace"]).toBe("t1");
  });

  it("on 401 marks key bad and retries with a different key", async () => {
    _resetForTests("k1,k2");
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: "bad" }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const res = await jinaFetch("https://r.jina.ai/u");
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(poolSize()).toBe(1);
    const firstAuth = fetchMock.mock.calls[0][1].headers.Authorization;
    const secondAuth = fetchMock.mock.calls[1][1].headers.Authorization;
    expect(firstAuth).toMatch(/^Bearer k[12]$/);
    expect(secondAuth).toMatch(/^Bearer k[12]$/);
    expect(firstAuth).not.toBe(secondAuth);
  });

  it("on 403 marks key bad and retries", async () => {
    _resetForTests("k1,k2");
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: "forbidden" }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await jinaFetch("https://r.jina.ai/u");
    expect(poolSize()).toBe(1);
  });

  it("on 5xx does NOT mark key bad and returns the response", async () => {
    _resetForTests("k1,k2");
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: "down" }));
    const res = await jinaFetch("https://r.jina.ai/u");
    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(poolSize()).toBe(2);
  });

  it("throws when pool is exhausted by repeated auth failures", async () => {
    _resetForTests("k1,k2");
    fetchMock.mockResolvedValue(jsonResponse(401, { error: "bad" }));

    await expect(jinaFetch("https://r.jina.ai/u")).rejects.toThrow(/exhausted/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(poolSize()).toBe(0);
  });

  it("throws immediately when pool starts empty", async () => {
    _resetForTests(undefined);
    await expect(jinaFetch("https://r.jina.ai/u")).rejects.toThrow(/empty/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
