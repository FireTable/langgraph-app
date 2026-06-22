import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db/client";
import { threads } from "@/lib/threads/schema";
import {
  listThreads,
  getThread,
  createThread,
  renameThread,
  archiveThread,
  unarchiveThread,
  deleteThread,
  updateCustom,
  touchLastMessageAt,
} from "@/lib/threads/queries";

const testUrl = process.env.DATABASE_URL_TEST;
if (!testUrl) throw new Error("DATABASE_URL_TEST required");

beforeEach(async () => {
  await db.delete(threads);
});

describe("listThreads", () => {
  it("returns empty when no rows", async () => {
    expect(await listThreads()).toEqual([]);
  });

  it("excludes archived threads", async () => {
    await db.insert(threads).values([
      { id: "a", title: "active" },
      { id: "b", title: "archived", status: "archived" },
    ]);
    const result = await listThreads();
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("a");
  });

  it("orders by updatedAt DESC", async () => {
    await db.insert(threads).values([
      { id: "old", title: "old", updatedAt: new Date("2024-01-01") },
      { id: "new", title: "new", updatedAt: new Date("2024-06-01") },
    ]);
    const [first] = await listThreads();
    expect(first?.id).toBe("new");
  });
});

describe("getThread", () => {
  it("returns row when exists", async () => {
    await db.insert(threads).values({ id: "x", title: "x" });
    const row = await getThread("x");
    expect(row?.id).toBe("x");
  });

  it("returns undefined when missing", async () => {
    expect(await getThread("nope")).toBeUndefined();
  });
});

describe("createThread", () => {
  it("generates a UUID id (required by LangGraph's /threads/[id] routes)", async () => {
    const t = await createThread();
    // UUID v4: 8-4-4-4-12 hex, e.g. "550e8400-e29b-41d4-a716-446655440000"
    expect(t.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("uses default title when omitted", async () => {
    const t = await createThread();
    expect(t.title).toBe("New Chat");
  });

  it("uses provided title", async () => {
    const t = await createThread("hi");
    expect(t.title).toBe("hi");
  });

  it("sets status regular and empty custom", async () => {
    const t = await createThread();
    expect(t.status).toBe("regular");
    expect(t.custom).toEqual({});
  });

  it("sets lastMessageAt to ~now on insert", async () => {
    const before = Date.now();
    const t = await createThread();
    const after = Date.now();
    // Column is timestamp NOT NULL with DEFAULT now(); the DB fills the
    // value so we just check it's within the call window.
    expect(t.lastMessageAt).toBeInstanceOf(Date);
    expect(t.lastMessageAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(t.lastMessageAt.getTime()).toBeLessThanOrEqual(after);
  });
});

describe("renameThread", () => {
  it("updates title", async () => {
    await db.insert(threads).values({ id: "r", title: "old" });
    const updated = await renameThread("r", "new");
    expect(updated?.title).toBe("new");
  });
});

describe("archiveThread / unarchiveThread", () => {
  it("archive sets status to archived", async () => {
    await db.insert(threads).values({ id: "a" });
    await archiveThread("a");
    const row = await getThread("a");
    expect(row?.status).toBe("archived");
  });

  it("unarchive sets status back to regular", async () => {
    await db.insert(threads).values({ id: "a", status: "archived" });
    await unarchiveThread("a");
    const row = await getThread("a");
    expect(row?.status).toBe("regular");
  });
});

describe("deleteThread", () => {
  it("removes row", async () => {
    await db.insert(threads).values({ id: "d" });
    await deleteThread("d");
    expect(await getThread("d")).toBeUndefined();
  });
});

describe("updateCustom", () => {
  it("replaces custom jsonb", async () => {
    await db.insert(threads).values({ id: "c", custom: { old: 1 } });
    await updateCustom("c", { new: "value" });
    const row = await getThread("c");
    expect(row?.custom).toEqual({ new: "value" });
  });
});

describe("touchLastMessageAt", () => {
  it("updates lastMessageAt without changing other fields", async () => {
    const original = new Date("2024-01-01");
    await db
      .insert(threads)
      .values({ id: "lm", title: "keep", updatedAt: original, lastMessageAt: original });
    await new Promise((r) => setTimeout(r, 10));
    await touchLastMessageAt("lm");
    const row = await getThread("lm");
    expect(row?.title).toBe("keep");
    expect(row?.updatedAt.getTime()).toBe(original.getTime());
    expect(row?.lastMessageAt.getTime()).toBeGreaterThan(original.getTime());
  });

  it("leaves updatedAt untouched (lastMessageAt is its own clock)", async () => {
    const originalUpdatedAt = new Date("2024-01-01");
    const originalLastMessage = new Date("2024-01-02");
    await db.insert(threads).values({
      id: "lm2",
      title: "keep",
      updatedAt: originalUpdatedAt,
      lastMessageAt: originalLastMessage,
    });
    await new Promise((r) => setTimeout(r, 10));
    await touchLastMessageAt("lm2");
    const row = await getThread("lm2");
    expect(row?.updatedAt.getTime()).toBe(originalUpdatedAt.getTime());
    expect(row?.lastMessageAt.getTime()).toBeGreaterThan(originalLastMessage.getTime());
  });
});
