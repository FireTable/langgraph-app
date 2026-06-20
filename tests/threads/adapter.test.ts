import { describe, it, expect, beforeEach, vi } from "vitest";
import { threadListAdapter } from "@/lib/threads/adapter";

function mockFetch(
  responses: Array<{ url: RegExp; init?: RequestInit; body: unknown; status?: number }>,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    for (const r of responses) {
      if (r.url.test(url)) {
        return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
      }
    }
    return new Response("Not found", { status: 404 });
  });
  return { fn, calls };
}

describe("threadListAdapter.list", () => {
  it("calls GET /api/threads and returns threads", async () => {
    const { fn } = mockFetch([
      {
        url: /\/api\/threads$/,
        body: { threads: [{ status: "regular", remoteId: "abc", title: "hi" }] },
      },
    ]);
    const original = globalThis.fetch;
    globalThis.fetch = fn as unknown as typeof fetch;
    try {
      const result = await threadListAdapter.list!();
      expect(result.threads).toEqual([{ status: "regular", remoteId: "abc", title: "hi" }]);
      expect(fn).toHaveBeenCalledTimes(1);
      const [calledUrl] = fn.mock.calls[0]!;
      expect(calledUrl.toString()).toMatch(/\/api\/threads$/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("threadListAdapter.initialize", () => {
  it("calls POST /api/threads and returns remoteId", async () => {
    const { fn } = mockFetch([
      {
        url: /\/api\/threads$/,
        body: { status: "regular", remoteId: "new-id", title: "New chat" },
      },
    ]);
    const original = globalThis.fetch;
    globalThis.fetch = fn as unknown as typeof fetch;
    try {
      const result = await threadListAdapter.initialize!("local-1");
      expect(result.remoteId).toBe("new-id");
      const [, init] = fn.mock.calls[0]!;
      expect(init?.method).toBe("POST");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("threadListAdapter.rename", () => {
  it("PATCHes title to /api/threads/[id]", async () => {
    const { fn } = mockFetch([
      { url: /\/api\/threads\/abc$/, body: { status: "regular", remoteId: "abc", title: "new" } },
    ]);
    const original = globalThis.fetch;
    globalThis.fetch = fn as unknown as typeof fetch;
    try {
      await threadListAdapter.rename!("abc", "new");
      const [, init] = fn.mock.calls[0]!;
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(init?.body as string)).toEqual({ title: "new" });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("threadListAdapter.archive / unarchive", () => {
  it("archive PATCHes status=archived", async () => {
    const { fn } = mockFetch([{ url: /\/api\/threads\/abc$/, body: {} }]);
    const original = globalThis.fetch;
    globalThis.fetch = fn as unknown as typeof fetch;
    try {
      await threadListAdapter.archive!("abc");
      const [, init] = fn.mock.calls[0]!;
      expect(JSON.parse(init?.body as string)).toEqual({ status: "archived" });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("unarchive PATCHes status=regular", async () => {
    const { fn } = mockFetch([{ url: /\/api\/threads\/abc$/, body: {} }]);
    const original = globalThis.fetch;
    globalThis.fetch = fn as unknown as typeof fetch;
    try {
      await threadListAdapter.unarchive!("abc");
      const [, init] = fn.mock.calls[0]!;
      expect(JSON.parse(init?.body as string)).toEqual({ status: "regular" });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("threadListAdapter.delete", () => {
  it("DELETEs /api/threads/[id]", async () => {
    const { fn } = mockFetch([{ url: /\/api\/threads\/abc$/, body: {} }]);
    const original = globalThis.fetch;
    globalThis.fetch = fn as unknown as typeof fetch;
    try {
      await threadListAdapter.delete!("abc");
      const [, init] = fn.mock.calls[0]!;
      expect(init?.method).toBe("DELETE");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("threadListAdapter.fetch", () => {
  it("GETs /api/threads/[id] and returns metadata", async () => {
    const { fn } = mockFetch([
      {
        url: /\/api\/threads\/abc$/,
        body: { status: "regular", remoteId: "abc", title: "x" },
      },
    ]);
    const original = globalThis.fetch;
    globalThis.fetch = fn as unknown as typeof fetch;
    try {
      const result = await threadListAdapter.fetch!("abc");
      expect(result).toMatchObject({ status: "regular", remoteId: "abc", title: "x" });
    } finally {
      globalThis.fetch = original;
    }
  });
});
