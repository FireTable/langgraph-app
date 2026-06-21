import { describe, it, expect, vi } from "vitest";
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
  it("calls GET /api/threads and returns threads with remoteId + externalId", async () => {
    const { fn } = mockFetch([
      {
        url: /\/api\/threads$/,
        body: { threads: [{ status: "regular", id: "abc", title: "hi" }] },
      },
    ]);
    const original = globalThis.fetch;
    globalThis.fetch = fn as unknown as typeof fetch;
    try {
      const result = await threadListAdapter.list!();
      expect(result.threads).toEqual([
        {
          status: "regular",
          remoteId: "abc",
          externalId: "abc",
          title: "hi",
          lastMessageAt: undefined,
        },
      ]);
      expect(fn).toHaveBeenCalledTimes(1);
      const [calledUrl] = fn.mock.calls[0]!;
      expect(calledUrl.toString()).toMatch(/\/api\/threads$/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("threadListAdapter.initialize", () => {
  it("calls POST /api/threads and returns remoteId + externalId", async () => {
    const { fn } = mockFetch([
      {
        url: /\/api\/threads$/,
        body: { status: "regular", id: "new-id", title: "New Chat" },
      },
    ]);
    const original = globalThis.fetch;
    globalThis.fetch = fn as unknown as typeof fetch;
    try {
      const result = await threadListAdapter.initialize!("local-1");
      expect(result).toEqual({ remoteId: "new-id", externalId: "new-id" });
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
  it("GETs /api/threads/[id] and returns metadata with remoteId + externalId", async () => {
    const { fn } = mockFetch([
      {
        url: /\/api\/threads\/abc$/,
        body: { status: "regular", id: "abc", title: "x" },
      },
    ]);
    const original = globalThis.fetch;
    globalThis.fetch = fn as unknown as typeof fetch;
    try {
      const result = await threadListAdapter.fetch!("abc");
      expect(result).toEqual({
        status: "regular",
        remoteId: "abc",
        externalId: "abc",
        title: "x",
        lastMessageAt: undefined,
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("does not produce double slashes when id is the only segment", async () => {
    const { fn } = mockFetch([{ url: /\/api\/threads\/abc$/, body: {} }]);
    const original = globalThis.fetch;
    globalThis.fetch = fn as unknown as typeof fetch;
    try {
      await threadListAdapter.fetch!("abc");
      const [calledUrl] = fn.mock.calls[0]!;
      expect(calledUrl.toString()).not.toMatch(/\/\//);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("threadListAdapter.generateTitle", () => {
  it("streams the current thread title back so the runtime's auto-apply doesn't clobber it", async () => {
    // The empty-stream no-op caused the runtime to overwrite the title
    // we set from the rename-thread custom event. Yielding the current
    // title back makes the runtime's apply a no-op visually.
    const original = globalThis.fetch;
    const fn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "abc", status: "regular", title: "Existing title" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fn as unknown as typeof fetch;
    try {
      const stream = await threadListAdapter.generateTitle!("abc", [] as never);
      // assistant-stream yields text-part objects; stringify each chunk
      // and check the title appears somewhere in the wire output.
      const reader = stream.getReader();
      const text: string[] = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        text.push(typeof value === "string" ? value : JSON.stringify(value));
      }
      // The title must appear somewhere in the streamed chunks.
      expect(text.join("")).toContain("Existing title");
      // The adapter must have fetched the current thread to read its title.
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});
