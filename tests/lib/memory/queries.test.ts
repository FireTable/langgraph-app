/* oxlint-disable unicorn/no-thenable */
// ponytail: drizzle's query builder is a thenable — `await db.select(...)`
// executes the query. The mock has to be thenable for `await` to work,
// but the lint rule (unicorn/no-thenable) forbids `then` on objects/classes.
// We need a real thenable for the SUT's `await db.select(...)` to work.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock so `vi.mock("@/backend/store")` can see it before the
// SUT imports `store` itself.
const { mockStore } = vi.hoisted(() => ({
  mockStore: {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    search: vi.fn(),
    batch: vi.fn(),
  },
}));

// ponytail: chainable drizzle mock. Two select paths exist:
//   1) db.select(...).from(user).where(...).limit(1)   → mockSelectLimit result
//   2) db.select(...).from(account).where(...)         → mockSelectAll result
// Each step in the chain is itself thenable (resolves to mockSelectAll by
// default) AND has a method to advance to the next step. .limit(1) short-
// circuits the thenable to mockSelectLimit. Two mocks because the queries
// are independent — different stages can be in flight in the same test.
const { mockSelectLimit, mockSelectAll } = vi.hoisted(() => ({
  mockSelectLimit: vi.fn(),
  mockSelectAll: vi.fn(),
}));

// ponytail: drizzle's query builder is a thenable — `await db.select(...)`
// executes the query. The mock has to be thenable for `await` to work,
// but the lint rule (unicorn/no-thenable) flags `then` as a method.
// Class with `then` on the prototype is the cleanest way to express this.
class FakeQueryBuilder {
  terminal: () => unknown;
  constructor(terminal: () => unknown = () => mockSelectAll()) {
    this.terminal = terminal;
  }
}
(FakeQueryBuilder.prototype as unknown as { then: unknown }).then = function (
  this: FakeQueryBuilder,
  resolve: (v: unknown) => unknown,
  reject: (e: unknown) => unknown,
) {
  return Promise.resolve(this.terminal()).then(resolve, reject);
};

function makeChainable(
  next: Record<string, () => unknown> = {},
  terminal: () => unknown = () => mockSelectAll(),
) {
  const builder = new FakeQueryBuilder(terminal);
  for (const [k, v] of Object.entries(next)) {
    (builder as unknown as Record<string, unknown>)[k] = v;
  }
  return builder;
}

const withLimit = makeChainable({}, mockSelectLimit);
const afterFrom = makeChainable({ where: () => makeChainable({ limit: () => withLimit }) });
const startChain = makeChainable({ from: () => afterFrom });

vi.mock("@/backend/store", () => ({ store: mockStore }));
vi.mock("@/db/client", () => ({ db: { select: vi.fn(() => startChain) } }));
vi.mock("@/lib/auth/schema", () => ({
  account: { userId: "userId", providerId: "providerId" },
  user: { id: "id", name: "name", email: "email", image: "image" },
}));

import {
  getMemoryDoc,
  putMemoryDoc,
  deleteMemoryField,
  getAllUserSummaries,
  getRecentThreadSummaries,
  deleteThreadSummaries,
  writeSummary,
  getAuthInfo,
} from "@/lib/memory/queries";

const USER = "u-test";

beforeEach(() => {
  Object.values(mockStore).forEach((fn) => (fn as ReturnType<typeof vi.fn>).mockReset());
  mockSelectLimit.mockReset();
  mockSelectAll.mockReset();
});

describe("lib/memory/queries", () => {
  describe("getMemoryDoc", () => {
    it("returns an empty memory when the store has no row", async () => {
      mockStore.get.mockResolvedValueOnce(null);
      const doc = await getMemoryDoc(USER);
      expect(doc).toEqual({});
      expect(mockStore.get).toHaveBeenCalledWith([USER, "memory"], "main");
    });

    it("returns the stored value object unwrapped", async () => {
      mockStore.get.mockResolvedValueOnce({
        namespace: [USER, "memory"],
        key: "main",
        value: { role: "frontend", language: "zh" },
        createdAt: "2026-07-02T00:00:00.000Z",
        updatedAt: "2026-07-02T00:00:00.000Z",
      });
      const doc = await getMemoryDoc(USER);
      expect(doc).toEqual({ role: "frontend", language: "zh" });
    });
  });

  describe("putMemoryDoc", () => {
    it("writes to the canonical namespace + key", async () => {
      mockStore.put.mockResolvedValueOnce(undefined);
      await putMemoryDoc(USER, { role: "frontend" });
      expect(mockStore.put).toHaveBeenCalledWith([USER, "memory"], "main", {
        role: "frontend",
      });
    });
  });

  describe("deleteMemoryField", () => {
    it("returns null when memory does not exist", async () => {
      mockStore.get.mockResolvedValueOnce(null);
      const result = await deleteMemoryField(USER, "role");
      expect(result).toBeNull();
      expect(mockStore.put).not.toHaveBeenCalled();
    });

    it("returns null when key is not in the memory", async () => {
      mockStore.get.mockResolvedValueOnce({
        value: { language: "zh" },
      });
      const result = await deleteMemoryField(USER, "role");
      expect(result).toBeNull();
    });

    it("removes the key + writes back the rest", async () => {
      mockStore.get.mockResolvedValueOnce({
        value: { role: "frontend", language: "zh" },
      });
      mockStore.put.mockResolvedValueOnce(undefined);
      const result = await deleteMemoryField(USER, "role");
      expect(result).toBe("role");
      expect(mockStore.put).toHaveBeenCalledWith([USER, "memory"], "main", {
        language: "zh",
      });
    });
  });

  describe("getAuthInfo", () => {
    it("returns name/email/image from user + providers from account", async () => {
      mockSelectLimit.mockResolvedValueOnce([{ name: "Lin", email: "lin@x.com", image: null }]);
      mockSelectAll.mockResolvedValueOnce([{ provider: "github" }, { provider: "google" }]);
      const info = await getAuthInfo(USER);
      expect(info).toEqual({
        name: "Lin",
        email: "lin@x.com",
        image: null,
        socials: [{ provider: "github" }, { provider: "google" }],
      });
    });

    it("returns nulls + empty socials when user has no auth row", async () => {
      mockSelectLimit.mockResolvedValueOnce([]);
      mockSelectAll.mockResolvedValueOnce([]);
      const info = await getAuthInfo(USER);
      expect(info).toEqual({ name: null, email: null, image: null, socials: [] });
    });

    it("filters out the credential provider (email+password account)", async () => {
      mockSelectLimit.mockResolvedValueOnce([{ name: "Lin", email: "lin@x.com", image: null }]);
      mockSelectAll.mockResolvedValueOnce([{ provider: "credential" }, { provider: "github" }]);
      const info = await getAuthInfo(USER);
      expect(info.socials).toEqual([{ provider: "github" }]);
    });
  });

  describe("writeSummary", () => {
    it("stores under [userId,threads] with composite key + ISO createdAt", async () => {
      mockStore.put.mockResolvedValueOnce(undefined);
      const written = await writeSummary(USER, {
        threadId: "t1",
        sequence: 1,
        startMessageIndex: 0,
        endMessageIndex: 6,
        messageCount: 7,
        messageIds: ["m0", "m1", "m2", "m3", "m4", "m5", "m6"],
        summary: "#1-#4 Q: ... A: ...",
      });
      expect(written.threadId).toBe("t1");
      expect(written.sequence).toBe(1);
      expect(typeof written.createdAt).toBe("string");
      expect(mockStore.put).toHaveBeenCalledWith([USER, "threads"], "t1:1", written);
    });

    it("rejects summaries whose messageIds length drifts from messageCount", async () => {
      // ponytail: the schema's `messageIds.length === messageCount` refine
      // catches the bug at write-time so the node can't persist a row
      // that's out of sync with the closed interval. writeSummary itself
      // trusts its caller — the schema gate happens in callers that
      // import SummaryEntrySchema. This test pins the schema invariant
      // here too so a future reader sees the rule.
      const { SummaryEntrySchema } = await import("@/lib/memory/validators");
      const r = SummaryEntrySchema.safeParse({
        threadId: "t1",
        sequence: 1,
        startMessageIndex: 0,
        endMessageIndex: 2,
        messageCount: 3,
        messageIds: ["m0", "m1"],
        summary: "#1-#3 Q: ... A: ...",
        createdAt: "2026-07-02T00:00:00.000Z",
      });
      expect(r.success).toBe(false);
    });
  });

  describe("getAllUserSummaries", () => {
    it("returns the parsed summaries", async () => {
      mockStore.search.mockResolvedValueOnce([
        {
          namespace: [USER, "threads"],
          key: "t1:1",
          value: {
            threadId: "t1",
            sequence: 1,
            startMessageIndex: 0,
            endMessageIndex: 6,
            messageCount: 7,
            messageIds: ["m0", "m1", "m2", "m3", "m4", "m5", "m6"],
            summary: "#1-#4 Q: ... A: ...",
            createdAt: "2026-07-02T00:00:00.000Z",
          },
          createdAt: "2026-07-02T00:00:00.000Z",
          updatedAt: "2026-07-02T00:00:00.000Z",
        },
      ]);
      const summaries = await getAllUserSummaries(USER);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.key).toBe("t1:1");
      expect(summaries[0]?.value.threadId).toBe("t1");
    });

    it("skips corrupt summaries (zod fails) and keeps the rest", async () => {
      mockStore.search.mockResolvedValueOnce([
        {
          key: "t1:1",
          value: { corrupt: true },
        },
        {
          key: "t2:1",
          value: {
            threadId: "t2",
            sequence: 1,
            startMessageIndex: 0,
            endMessageIndex: 0,
            messageCount: 1,
            messageIds: ["m0"],
            summary: "#1 Q: ... A: ...",
            createdAt: "2026-07-02T00:00:00.000Z",
          },
        },
      ]);
      const summaries = await getAllUserSummaries(USER);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.key).toBe("t2:1");
    });
  });

  describe("getRecentThreadSummaries", () => {
    it("orders by createdAt desc and returns top-K", async () => {
      mockStore.search.mockResolvedValueOnce([
        { key: "t1:1", value: makeSummary("t1", 1, "2026-07-01T00:00:00.000Z") },
        { key: "t2:1", value: makeSummary("t2", 1, "2026-07-02T00:00:00.000Z") },
        { key: "t3:1", value: makeSummary("t3", 1, "2026-06-30T00:00:00.000Z") },
      ]);
      const top = await getRecentThreadSummaries(USER, 2);
      expect(top.map((s) => s.key)).toEqual(["t2:1", "t1:1"]);
    });
  });

  describe("deleteThreadSummaries", () => {
    it("returns 0 when no summaries for the thread", async () => {
      mockStore.search.mockResolvedValueOnce([]);
      const n = await deleteThreadSummaries(USER, "t1");
      expect(n).toBe(0);
      expect(mockStore.delete).not.toHaveBeenCalled();
    });

    it("deletes per-key via store.delete, never store.batch", async () => {
      mockStore.search.mockResolvedValueOnce([
        { key: "t1:1", value: makeSummary("t1", 1, "2026-07-02T00:00:00.000Z") },
        { key: "t1:2", value: makeSummary("t1", 2, "2026-07-02T00:00:00.000Z") },
        { key: "t2:1", value: makeSummary("t2", 1, "2026-07-02T00:00:00.000Z") },
      ]);
      mockStore.delete.mockResolvedValue(undefined);
      const n = await deleteThreadSummaries(USER, "t1");
      expect(n).toBe(2);
      expect(mockStore.delete).toHaveBeenCalledTimes(2);
      expect(mockStore.batch).not.toHaveBeenCalled();
      expect(mockStore.delete).toHaveBeenNthCalledWith(1, [USER, "threads"], "t1:1");
      expect(mockStore.delete).toHaveBeenNthCalledWith(2, [USER, "threads"], "t1:2");
    });
  });
});

function makeSummary(threadId: string, sequence: number, createdAt: string) {
  return {
    threadId,
    sequence,
    startMessageIndex: 0,
    endMessageIndex: 0,
    messageCount: 1,
    messageIds: ["m0"],
    summary: "#1 Q: ... A: ...",
    createdAt,
  };
}

afterEach(() => {
  Object.values(mockStore).forEach((fn) => (fn as ReturnType<typeof vi.fn>).mockReset());
});
