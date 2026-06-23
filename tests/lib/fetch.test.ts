import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { jsonFetch } from "@/lib/fetch";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("ok"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("jsonFetch", () => {
  it("always sends credentials: include", async () => {
    await jsonFetch("/api/x");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/x",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("sets Content-Type and stringifies the body when body is given", async () => {
    await jsonFetch("/api/x", { method: "POST", body: { a: 1 } });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe('{"a":1}');
  });

  it("omits Content-Type and body when no body is given", async () => {
    await jsonFetch("/api/x", { method: "GET" });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["Content-Type"]).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it("preserves caller-provided headers alongside the default Content-Type", async () => {
    await jsonFetch("/api/x", {
      method: "POST",
      body: { a: 1 },
      headers: { "x-trace": "abc" },
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers["x-trace"]).toBe("abc");
  });

  it("forwards method and any extra init fields", async () => {
    await jsonFetch("/api/x", { method: "DELETE", cache: "no-store" });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("DELETE");
    expect(init.cache).toBe("no-store");
  });
});
