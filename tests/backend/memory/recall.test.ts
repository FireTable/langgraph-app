import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SystemMessage } from "@langchain/core/messages";

const { mockGetMemoryDoc, mockGetAuthInfo } = vi.hoisted(() => ({
  mockGetMemoryDoc: vi.fn(),
  mockGetAuthInfo: vi.fn(),
}));

vi.mock("@/lib/memory/queries", () => ({
  getMemoryDoc: mockGetMemoryDoc,
  getAuthInfo: mockGetAuthInfo,
}));

import {
  extractUserId,
  getCachedMemory,
  loadMemory,
  invalidateMemory,
} from "@/backend/memory/recall";
import { buildSystemMessageWithMemory } from "@/backend/memory/template";

const emptyAuth = {
  name: null,
  email: null,
  image: null,
  socials: [] as Array<{ provider: string }>,
};

beforeEach(() => {
  mockGetMemoryDoc.mockReset();
  mockGetAuthInfo.mockReset();
  // ponytail: the LRU cache is module-scoped — drain every test userId
  // before each test so cross-test pollution doesn't make hits look
  // like misses (or vice versa).
  invalidateMemory("u1");
  invalidateMemory("u2");
  invalidateMemory("u3");
});

afterEach(() => vi.clearAllMocks());

describe("extractUserId", () => {
  it("returns null when config is missing", () => {
    expect(extractUserId(undefined)).toBeNull();
  });

  it("returns null when configurable is missing", () => {
    expect(extractUserId({})).toBeNull();
  });

  it("returns null when userId is missing", () => {
    expect(extractUserId({ configurable: {} })).toBeNull();
  });

  it("returns null when userId is empty string", () => {
    expect(extractUserId({ configurable: { userId: "" } })).toBeNull();
  });

  it("returns null when userId is non-string", () => {
    expect(extractUserId({ configurable: { userId: 42 } })).toBeNull();
  });

  it("returns the userId when present", () => {
    expect(extractUserId({ configurable: { userId: "u1" } })).toBe("u1");
  });
});

describe("loadMemory", () => {
  it("fetches memory + auth in parallel and overlays auth (no threads fetch)", async () => {
    // ponytail: loadMemory used to call getRecentThreadSummaries too,
    // but cross-thread summary injection into the system prompt was
    // retired — that path leaked threads into the model's context and
    // is replaced by inline messages-channel summaries. Same fetch cost
    // as before minus one Postgres scan, so memory loading stays cheap.
    mockGetMemoryDoc.mockResolvedValueOnce({ role: "backend" });
    mockGetAuthInfo.mockResolvedValueOnce({
      name: "Lin",
      email: "lin@x.com",
      image: null,
      socials: [{ provider: "github" }],
    });

    const payload = await loadMemory("u1");

    expect(mockGetMemoryDoc).toHaveBeenCalledWith("u1");
    expect(mockGetAuthInfo).toHaveBeenCalledWith("u1");
    expect(payload.memory).toEqual({
      role: "backend",
      name: "Lin",
      email: "lin@x.com",
      socials: [{ provider: "github" }],
    });
    // ponytail: payload no longer carries `threads` — that field was
    // removed when cross-thread injection was retired.
    expect(payload).not.toHaveProperty("threads");
  });

  it("user-saved fields win over auth overlay (name/email/image/socials)", async () => {
    mockGetMemoryDoc.mockResolvedValueOnce({ name: "Saved", role: "backend" });
    mockGetAuthInfo.mockResolvedValueOnce({
      name: "FromAuth",
      email: "auth@x.com",
      image: null,
      socials: [{ provider: "github" }],
    });

    const payload = await loadMemory("u1");

    // user-saved name wins; auth fills the rest
    expect(payload.memory).toMatchObject({
      name: "Saved",
      role: "backend",
      email: "auth@x.com",
      socials: [{ provider: "github" }],
    });
  });

  it("degrades to empty when memory fetch rejects", async () => {
    mockGetMemoryDoc.mockRejectedValueOnce(new Error("db down"));
    mockGetAuthInfo.mockResolvedValueOnce(emptyAuth);

    const payload = await loadMemory("u1");

    // both sides empty → nothing merged in
    expect(payload.memory).toEqual({});
  });

  it("degrades to empty when auth fetch rejects", async () => {
    mockGetMemoryDoc.mockResolvedValueOnce({ role: "backend" });
    mockGetAuthInfo.mockRejectedValueOnce(new Error("db down"));

    const payload = await loadMemory("u1");

    // empty auth → no overlay
    expect(payload.memory).toEqual({ role: "backend" });
  });
});

describe("getCachedMemory", () => {
  it("fetches and caches on miss", async () => {
    mockGetMemoryDoc.mockResolvedValueOnce({ role: "backend" });
    mockGetAuthInfo.mockResolvedValueOnce(emptyAuth);

    const first = await getCachedMemory("u1");
    const second = await getCachedMemory("u1");

    expect(first?.memory.role).toBe("backend");
    expect(second).toBe(first); // same reference — served from cache
    expect(mockGetMemoryDoc).toHaveBeenCalledTimes(1);
  });

  it("returns null when userId is empty", async () => {
    const result = await getCachedMemory("");
    expect(result).toBeNull();
    expect(mockGetMemoryDoc).not.toHaveBeenCalled();
  });
});

describe("invalidateMemory", () => {
  it("forces the next read to refetch", async () => {
    mockGetMemoryDoc.mockResolvedValueOnce({ v: 1 });
    mockGetAuthInfo.mockResolvedValue(emptyAuth);

    const before = await getCachedMemory("u1");
    expect(before?.memory.v).toBe(1);

    invalidateMemory("u1");

    mockGetMemoryDoc.mockResolvedValueOnce({ v: 2 });
    const after = await getCachedMemory("u1");
    expect(after?.memory.v).toBe(2);
    expect(mockGetMemoryDoc).toHaveBeenCalledTimes(2);
  });
});

describe("buildSystemMessageWithMemory", () => {
  it("returns a SystemMessage with just the base prompt when no userId", async () => {
    const msg = await buildSystemMessageWithMemory("You are helpful.", undefined);
    expect(msg).toBeInstanceOf(SystemMessage);
    expect(msg.content).toBe("You are helpful.");
    expect(mockGetMemoryDoc).not.toHaveBeenCalled();
  });

  it("merges memory block into the system message when userId is present", async () => {
    mockGetMemoryDoc.mockResolvedValueOnce({ role: "backend" });
    mockGetAuthInfo.mockResolvedValueOnce(emptyAuth);

    const msg = await buildSystemMessageWithMemory("You are helpful.", {
      configurable: { userId: "u1" },
    });

    const text = String(msg.content);
    expect(text).toContain("You are helpful.");
    expect(text).toContain("<memory>");
    expect(text).toContain("backend");
  });

  it("does NOT render a <threads> block (cross-thread injection retired)", async () => {
    // ponytail: the previous shape injected cross-thread summaries into
    // the system prompt via {{#threadsJson}}<threads>...</threads>.
    // That was confusing and leaky — thread summaries now live inline
    // in the messages channel of each thread. The Memory tab UI still
    // shows past-thread summaries via /api/memory/threads.
    mockGetMemoryDoc.mockResolvedValueOnce({ role: "backend" });
    mockGetAuthInfo.mockResolvedValueOnce(emptyAuth);

    const msg = await buildSystemMessageWithMemory("You are helpful.", {
      configurable: { userId: "u1" },
    });
    const text = String(msg.content);
    expect(text).not.toContain("<threads>");
    expect(text).not.toContain("</threads>");
  });
});
