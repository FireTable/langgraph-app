import "@/tests/helpers/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { db } from "@/db/client";
import { threads } from "@/lib/threads/schema";
import { listThreadsForUser, createThread } from "@/lib/threads/queries";
import { ensureTestUser, TEST_USER, cleanupUsers } from "@/tests/helpers/auth";

const createdThreadIds: string[] = [];

beforeEach(async () => {
  await ensureTestUser();
  await db.delete(threads).where(eqUser());
  createdThreadIds.length = 0;
});

afterEach(async () => {
  await db.delete(threads).where(eqUser());
  await cleanupUsers();
});

function eqUser() {
  // lazy import to avoid hot-reload cycles
  const { eq } = require("drizzle-orm") as typeof import("drizzle-orm");
  return eq(threads.userId, TEST_USER.id);
}

async function insertThread(overrides: Partial<typeof threads.$inferInsert> = {}) {
  const id = `t-${randomUUID()}`;
  await db.insert(threads).values({
    id,
    userId: TEST_USER.id,
    title: overrides.title ?? "Test thread",
    status: overrides.status ?? "regular",
    kind: overrides.kind ?? "chat",
    ...overrides,
  });
  createdThreadIds.push(id);
  return id;
}

describe("lib/threads/queries — listThreadsForUser", () => {
  it("returns chat threads for the user", async () => {
    await insertThread({ kind: "chat" });
    await insertThread({ kind: "chat", title: "Second chat" });
    const out = await listThreadsForUser(TEST_USER.id);
    expect(out).toHaveLength(2);
    expect(out.every((t) => t.kind === "chat")).toBe(true);
  });

  it("excludes kb kind threads from the chat sidebar", async () => {
    await insertThread({ kind: "chat" });
    await insertThread({ kind: "kb", title: "KB ingest 1" });
    await insertThread({ kind: "kb", title: "KB ingest 2" });
    const out = await listThreadsForUser(TEST_USER.id);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("chat");
  });

  it("still excludes user-archived chats (orthogonal to kind)", async () => {
    await insertThread({ kind: "chat", status: "regular" });
    await insertThread({ kind: "chat", status: "archived" });
    const out = await listThreadsForUser(TEST_USER.id);
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe("regular");
  });
});

describe("lib/threads/queries — createThread", () => {
  it("defaults kind to 'chat'", async () => {
    const t = await createThread({ userId: TEST_USER.id });
    expect(t.kind).toBe("chat");
  });
});
