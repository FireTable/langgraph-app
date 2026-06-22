import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { db } from "@/db/client";
import { threads } from "@/lib/threads/schema";
import {
  listThreadsForUser,
  getThreadForUser,
  createThread,
  renameThread,
  archiveThread,
  unarchiveThread,
  deleteThread,
  updateCustom,
  touchLastMessageAt,
} from "@/lib/threads/queries";
import { makeUser, cleanupUsers, ensureTestUser, TEST_USER } from "@/tests/helpers/auth";

const testUrl = process.env.DATABASE_URL_TEST;
if (!testUrl) throw new Error("DATABASE_URL_TEST required");

const owner = TEST_USER.id;

beforeAll(async () => {
  await ensureTestUser();
});

beforeEach(async () => {
  await db.delete(threads);
});

afterAll(async () => {
  await cleanupUsers();
});

describe("listThreadsForUser", () => {
  it("returns empty when no rows", async () => {
    expect(await listThreadsForUser(owner)).toEqual([]);
  });

  it("excludes archived threads", async () => {
    await db.insert(threads).values([
      { id: "a", userId: owner, title: "active" },
      { id: "b", userId: owner, title: "archived", status: "archived" },
    ]);
    const result = await listThreadsForUser(owner);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("a");
  });

  it("excludes other users' threads", async () => {
    const other = await makeUser();
    await db.insert(threads).values([
      { id: "mine", userId: owner, title: "mine" },
      { id: "theirs", userId: other.id, title: "theirs" },
    ]);
    const result = await listThreadsForUser(owner);
    expect(result.map((r) => r.id)).toEqual(["mine"]);
  });

  it("orders by updatedAt DESC", async () => {
    await db.insert(threads).values([
      { id: "old", userId: owner, title: "old", updatedAt: new Date("2024-01-01") },
      { id: "new", userId: owner, title: "new", updatedAt: new Date("2024-06-01") },
    ]);
    const [first] = await listThreadsForUser(owner);
    expect(first?.id).toBe("new");
  });
});

describe("getThreadForUser", () => {
  it("returns row when owned", async () => {
    await db.insert(threads).values({ id: "x", userId: owner, title: "x" });
    const row = await getThreadForUser("x", owner);
    expect(row?.id).toBe("x");
  });

  it("returns undefined for another user's thread (FR-019)", async () => {
    const other = await makeUser();
    await db.insert(threads).values({ id: "y", userId: other.id, title: "y" });
    expect(await getThreadForUser("y", owner)).toBeUndefined();
  });

  it("returns undefined when missing", async () => {
    expect(await getThreadForUser("nope", owner)).toBeUndefined();
  });
});

describe("createThread", () => {
  it("generates a UUID id (required by LangGraph's /threads/[id] routes)", async () => {
    const t = await createThread(owner);
    expect(t.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("binds the new row to the userId", async () => {
    const t = await createThread(owner);
    expect(t.userId).toBe(owner);
  });

  it("uses default title when omitted", async () => {
    const t = await createThread(owner);
    expect(t.title).toBe("New Chat");
  });

  it("uses provided title", async () => {
    const t = await createThread(owner, "hi");
    expect(t.title).toBe("hi");
  });

  it("sets status regular and empty custom", async () => {
    const t = await createThread(owner);
    expect(t.status).toBe("regular");
    expect(t.custom).toEqual({});
  });

  it("sets lastMessageAt to ~now on insert", async () => {
    const before = Date.now();
    const t = await createThread(owner);
    const after = Date.now();
    expect(t.lastMessageAt).toBeInstanceOf(Date);
    expect(t.lastMessageAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(t.lastMessageAt.getTime()).toBeLessThanOrEqual(after);
  });
});

describe("renameThread", () => {
  it("updates title (no ownership check — graph-internal)", async () => {
    await db.insert(threads).values({ id: "r", userId: owner, title: "old" });
    await renameThread("r", "new");
    const row = await db.query.threads.findFirst({ where: (t, { eq }) => eq(t.id, "r") });
    expect(row?.title).toBe("new");
  });
});

describe("archiveThread / unarchiveThread", () => {
  it("archive sets status to archived", async () => {
    await db.insert(threads).values({ id: "a", userId: owner });
    await archiveThread("a", owner);
    const row = await getThreadForUser("a", owner);
    expect(row?.status).toBe("archived");
  });

  it("unarchive sets status back to regular", async () => {
    await db.insert(threads).values({ id: "a", userId: owner, status: "archived" });
    await unarchiveThread("a", owner);
    const row = await getThreadForUser("a", owner);
    expect(row?.status).toBe("regular");
  });
});

describe("deleteThread", () => {
  it("removes row when owned", async () => {
    await db.insert(threads).values({ id: "d", userId: owner });
    await deleteThread("d", owner);
    expect(await getThreadForUser("d", owner)).toBeUndefined();
  });

  it("does not delete another user's thread", async () => {
    const other = await makeUser();
    await db.insert(threads).values({ id: "d2", userId: other.id });
    await deleteThread("d2", owner);
    const row = await getThreadForUser("d2", other.id);
    expect(row).toBeDefined();
  });
});

describe("updateCustom", () => {
  it("replaces custom jsonb", async () => {
    await db.insert(threads).values({ id: "c", userId: owner, custom: { old: 1 } });
    await updateCustom("c", owner, { new: "value" });
    const row = await getThreadForUser("c", owner);
    expect(row?.custom).toEqual({ new: "value" });
  });
});

describe("touchLastMessageAt", () => {
  it("updates lastMessageAt without changing other fields", async () => {
    const original = new Date("2024-01-01");
    await db.insert(threads).values({
      id: "lm",
      userId: owner,
      title: "keep",
      updatedAt: original,
      lastMessageAt: original,
    });
    await new Promise((r) => setTimeout(r, 10));
    await touchLastMessageAt("lm");
    const row = await db.query.threads.findFirst({ where: (t, { eq }) => eq(t.id, "lm") });
    expect(row?.title).toBe("keep");
    expect(row?.updatedAt.getTime()).toBe(original.getTime());
    expect(row?.lastMessageAt.getTime()).toBeGreaterThan(original.getTime());
  });

  it("leaves updatedAt untouched (lastMessageAt is its own clock)", async () => {
    const originalUpdatedAt = new Date("2024-01-01");
    const originalLastMessage = new Date("2024-01-02");
    await db.insert(threads).values({
      id: "lm2",
      userId: owner,
      title: "keep",
      updatedAt: originalUpdatedAt,
      lastMessageAt: originalLastMessage,
    });
    await new Promise((r) => setTimeout(r, 10));
    await touchLastMessageAt("lm2");
    const row = await db.query.threads.findFirst({ where: (t, { eq }) => eq(t.id, "lm2") });
    expect(row?.updatedAt.getTime()).toBe(originalUpdatedAt.getTime());
    expect(row?.lastMessageAt.getTime()).toBeGreaterThan(originalLastMessage.getTime());
  });
});
