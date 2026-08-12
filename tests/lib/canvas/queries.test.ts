import "@/tests/helpers/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { threads } from "@/lib/threads/schema";
import { user as userTable } from "@/lib/auth/schema";
import { canvasSnapshots } from "@/lib/canvas/schema";
import {
  getCanvasSnapshotForUser,
  threadOwnedByUser,
  upsertCanvasSnapshot,
  deleteCanvasSnapshot,
} from "@/lib/canvas/queries";
import { ensureTestUser, makeUser, TEST_USER } from "@/tests/helpers/auth";

const owner = TEST_USER.id;

beforeEach(async () => {
  // ponytail: ensureTestUser is gated on a module-level `ensured` flag
  // that doesn't reset between tests in this file. `cleanupUsers` (in
  // afterEach) deletes every row in `user`, so a later beforeEach sees
  // the user gone. The helper's onConflictDoNothing no-ops on
  // re-insert. We re-insert the test owner UNCONDITIONALLY here so the
  // FK from threads → user is satisfied.
  await ensureTestUser();
  await db
    .insert(userTable)
    .values({ id: owner, email: TEST_USER.email, name: "Test Owner" })
    .onConflictDoNothing();
  await db.delete(canvasSnapshots);
  await db.delete(threads).where(eq(threads.userId, owner));
});

afterEach(async () => {
  await db.delete(canvasSnapshots);
  await db.delete(threads).where(eq(threads.userId, owner));
  // ponytail: do NOT call cleanupUsers() — it nukes TEST_USER, which
  // breaks the next beforeEach. We track extra users ourselves via
  // `extraUserIds` and remove them below.
  for (const id of extraUserIds) await db.delete(userTable).where(eq(userTable.id, id));
  extraUserIds.length = 0;
});

const extraUserIds: string[] = [];

async function makeThread(userId: string, title = "test"): Promise<string> {
  const id = `t-${randomUUID()}`;
  await db.insert(threads).values({ id, userId, title, kind: "chat" });
  return id;
}

async function makeOtherUser(): Promise<{ id: string; email: string }> {
  const u = await makeUser();
  extraUserIds.push(u.id);
  return u;
}

const SAMPLE_DOC = { "shape:abc": { id: "shape:abc", typeName: "shape", x: 0, y: 0 } };

describe("lib/canvas/queries — getCanvasSnapshotForUser", () => {
  it("returns undefined when no row exists", async () => {
    const id = await makeThread(owner);
    const out = await getCanvasSnapshotForUser(id, owner);
    expect(out).toBeUndefined();
  });

  it("returns the row for the owner", async () => {
    const id = await makeThread(owner);
    await upsertCanvasSnapshot({ threadId: id, userId: owner, document: SAMPLE_DOC });
    const out = await getCanvasSnapshotForUser(id, owner);
    expect(out?.document).toEqual(SAMPLE_DOC);
    expect(out?.threadId).toBe(id);
  });

  it("returns undefined for a thread owned by another user (no enumeration)", async () => {
    const other = await makeOtherUser();
    const id = await makeThread(other.id);
    await upsertCanvasSnapshot({ threadId: id, userId: other.id, document: SAMPLE_DOC });
    const out = await getCanvasSnapshotForUser(id, owner);
    expect(out).toBeUndefined();
  });
});

describe("lib/canvas/queries — threadOwnedByUser", () => {
  it("true for owner", async () => {
    const id = await makeThread(owner);
    expect(await threadOwnedByUser(id, owner)).toBe(true);
  });

  it("false for other user", async () => {
    const other = await makeOtherUser();
    const id = await makeThread(other.id);
    expect(await threadOwnedByUser(id, owner)).toBe(false);
  });

  it("false for non-existent thread", async () => {
    expect(await threadOwnedByUser("does-not-exist", owner)).toBe(false);
  });
});

describe("lib/canvas/queries — upsertCanvasSnapshot", () => {
  it("inserts a new row on first save", async () => {
    const id = await makeThread(owner);
    const row = await upsertCanvasSnapshot({ threadId: id, userId: owner, document: SAMPLE_DOC });
    expect(row.threadId).toBe(id);
    expect(row.document).toEqual(SAMPLE_DOC);
  });

  it("updates an existing row in place on second save (no duplicate row)", async () => {
    const id = await makeThread(owner);
    await upsertCanvasSnapshot({ threadId: id, userId: owner, document: SAMPLE_DOC });
    const v2 = { "shape:def": { id: "shape:def", typeName: "shape", x: 5, y: 5 } };
    const row = await upsertCanvasSnapshot({ threadId: id, userId: owner, document: v2 });
    expect(row.document).toEqual(v2);
    const all = await db.select().from(canvasSnapshots).where(eq(canvasSnapshots.threadId, id));
    expect(all).toHaveLength(1);
  });

  it("rejects upsert for a thread the user does not own", async () => {
    const other = await makeOtherUser();
    const id = await makeThread(other.id);
    await expect(
      upsertCanvasSnapshot({ threadId: id, userId: owner, document: SAMPLE_DOC }),
    ).rejects.toThrow("thread not owned by user");
  });
});

describe("lib/canvas/queries — deleteCanvasSnapshot", () => {
  it("removes the row when the user owns the thread", async () => {
    const id = await makeThread(owner);
    await upsertCanvasSnapshot({ threadId: id, userId: owner, document: SAMPLE_DOC });
    await deleteCanvasSnapshot(id, owner);
    const out = await getCanvasSnapshotForUser(id, owner);
    expect(out).toBeUndefined();
  });

  it("no-op for a thread owned by another user", async () => {
    const other = await makeOtherUser();
    const id = await makeThread(other.id);
    await upsertCanvasSnapshot({ threadId: id, userId: other.id, document: SAMPLE_DOC });
    await deleteCanvasSnapshot(id, owner);
    const out = await getCanvasSnapshotForUser(id, other.id);
    expect(out).toBeDefined();
  });
});
