import "@/tests/helpers/session";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

// ponytail: capture checkpointer sweeps without a real langgraphjs dev.
vi.mock("@/backend/checkpointer", () => ({
  checkpointer: { deleteThread: vi.fn(async () => {}) },
  subgraphCheckpointerConfig: {},
}));
import { checkpointer } from "@/backend/checkpointer";
const mockCheckpointDelete = vi.mocked(checkpointer!.deleteThread);

vi.mock("@/lib/memory/queries", () => ({
  deleteThreadSummaries: vi.fn(async () => 0),
  deleteMemoryDoc: vi.fn(async () => {}),
}));
import { deleteMemoryDoc } from "@/lib/memory/queries";
const mockDeleteMemoryDoc = vi.mocked(deleteMemoryDoc);

import { db } from "@/db/client";
import { role, session, user } from "@/lib/auth/schema";
import { threads } from "@/lib/threads/schema";
import { setCurrentUser } from "@/tests/helpers/session";
import { TEST_USER } from "@/tests/helpers/auth";

import { GET } from "@/app/api/admin/users/route";
import { PATCH, DELETE } from "@/app/api/admin/users/[id]/route";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = { params: Promise.resolve(undefined as never) };
const ctxId = (id: string) => ({ params: Promise.resolve({ id }) });

const ADMIN = { id: TEST_USER.id, email: TEST_USER.email, roleId: "admin" };

async function seedRoles() {
  // ponytail: same shape as the production migration seeds — admin/user
  // are referenced by FK so they must exist before any user insert.
  await db.delete(user);
  await db.delete(role);
  await db
    .insert(role)
    .values([
      { id: "admin", name: "Admin", creditLimit: null, windowHours: 24 },
      { id: "user", name: "User", creditLimit: 100, windowHours: 24 },
      { id: "vip", name: "VIP", creditLimit: 500, windowHours: 24 },
    ])
    .onConflictDoNothing();
  await db
    .insert(user)
    .values({ id: TEST_USER.id, email: TEST_USER.email, name: "Test Owner", roleId: "admin" })
    .onConflictDoNothing();
}

beforeEach(async () => {
  await seedRoles();
  await db.delete(threads);
  mockCheckpointDelete.mockClear();
  mockDeleteMemoryDoc.mockClear();
  setCurrentUser(ADMIN);
});

afterAll(async () => {
  setCurrentUser(null);
});

describe("GET /api/admin/users", () => {
  it("returns 401 when unauthenticated", async () => {
    setCurrentUser(null);
    const res = await GET(new Request("http://localhost"), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when signed in but role is 'user'", async () => {
    setCurrentUser({ id: TEST_USER.id, email: TEST_USER.email, roleId: "user" });
    const res = await GET(new Request("http://localhost"), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 200 with users + role snapshot when admin", async () => {
    const res = await GET(new Request("http://localhost"), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toHaveLength(1);
    expect(body.users[0].id).toBe(TEST_USER.id);
    expect(body.users[0].roleName).toBe("Admin");
    expect(body.users[0].banned).toBe(false);
  });

  it("joins role.name for non-admin users too", async () => {
    await db
      .insert(user)
      .values({ id: "alice", email: "alice@test.local", name: "Alice", roleId: "user" });
    const res = await GET(new Request("http://localhost"), ctx);
    const body = await res.json();
    const alice = body.users.find((u: { id: string }) => u.id === "alice");
    expect(alice.roleName).toBe("User");
    expect(alice.banned).toBe(false);
  });
});

describe("PATCH /api/admin/users/[id]", () => {
  it("changes roleId for a non-admin user", async () => {
    await db
      .insert(user)
      .values({ id: "bob", email: "bob@test.local", name: "Bob", roleId: "user" });
    const res = await PATCH(jsonRequest({ roleId: "vip" }), ctxId("bob"));
    expect(res.status).toBe(200);
    const after = await db.query.user.findFirst({ where: (u, { eq }) => eq(u.id, "bob") });
    expect(after?.roleId).toBe("vip");
  });

  it("toggles banned flag", async () => {
    const res = await PATCH(jsonRequest({ banned: true }), ctxId(TEST_USER.id));
    expect(res.status).toBe(409); // last-admin guard fires because TEST_USER is admin

    await db
      .insert(user)
      .values({ id: "alice", email: "alice@test.local", name: "Alice", roleId: "user" });
    const r2 = await PATCH(jsonRequest({ banned: true }), ctxId("alice"));
    expect(r2.status).toBe(200);
    const after = await db.query.user.findFirst({ where: (u, { eq }) => eq(u.id, "alice") });
    expect(after?.banned).toBe(true);
  });

  it("returns 404 when the user does not exist", async () => {
    const res = await PATCH(jsonRequest({ roleId: "user" }), ctxId("missing"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when the target role does not exist", async () => {
    await db
      .insert(user)
      .values({ id: "alice", email: "alice@test.local", name: "Alice", roleId: "user" });
    const res = await PATCH(jsonRequest({ roleId: "ghost" }), ctxId("alice"));
    expect(res.status).toBe(404);
  });

  it("returns 400 on empty patch body", async () => {
    const res = await PATCH(jsonRequest({}), ctxId(TEST_USER.id));
    expect(res.status).toBe(400);
  });

  it("refuses to demote the last admin (409 LAST_ADMIN)", async () => {
    // Only TEST_USER is admin in this beforeEach.
    const res = await PATCH(jsonRequest({ roleId: "user" }), ctxId(TEST_USER.id));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("LAST_ADMIN");
  });

  it("allows demoting an admin when another admin exists", async () => {
    await db.insert(user).values({
      id: "second-admin",
      email: "second@test.local",
      name: "Second",
      roleId: "admin",
    });
    const res = await PATCH(jsonRequest({ roleId: "user" }), ctxId(TEST_USER.id));
    expect(res.status).toBe(200);
    const after = await db.query.user.findFirst({
      where: (u, { eq }) => eq(u.id, TEST_USER.id),
    });
    expect(after?.roleId).toBe("user");
  });

  it("banning revokes every existing session for that user", async () => {
    await db
      .insert(user)
      .values({ id: "alice", email: "alice@test.local", name: "Alice", roleId: "user" });
    // ponytail: seed two sessions for Alice across different devices.
    // The session.userId FK cascades on user delete, so we INSERT direct.
    await db.insert(session).values([
      {
        id: "sess-alice-1",
        token: "tok-alice-1",
        userId: "alice",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
      {
        id: "sess-alice-2",
        token: "tok-alice-2",
        userId: "alice",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    ]);

    const res = await PATCH(jsonRequest({ banned: true }), ctxId("alice"));
    expect(res.status).toBe(200);

    const remaining = await db.select().from(session).where(eq(session.userId, "alice"));
    expect(remaining).toHaveLength(0);
  });

  it("unbanning does NOT touch sessions (user signs in fresh)", async () => {
    await db.insert(user).values({
      id: "alice",
      email: "alice@test.local",
      name: "Alice",
      roleId: "user",
      banned: true,
    });
    await db.insert(session).values({
      id: "sess-alice-1",
      token: "tok-alice-1",
      userId: "alice",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    const res = await PATCH(jsonRequest({ banned: false }), ctxId("alice"));
    expect(res.status).toBe(200);

    const remaining = await db.select().from(session).where(eq(session.userId, "alice"));
    expect(remaining).toHaveLength(1);
  });

  it("unbanning the only admin succeeds (no false LAST_ADMIN)", async () => {
    // Regression: banned:false with no roleId in the body used to trip
    // the last-admin guard via `undefined !== "admin"`. Split the role
    // and ban checks so unban is unconditionally allowed.
    const res = await PATCH(jsonRequest({ banned: false }), ctxId(TEST_USER.id));
    expect(res.status).toBe(200);
    const after = await db.query.user.findFirst({ where: (u, { eq }) => eq(u.id, TEST_USER.id) });
    expect(after?.banned).toBe(false);
  });
});

describe("DELETE /api/admin/users/[id]", () => {
  it("removes a non-admin user (FK cascade handles sessions)", async () => {
    await db
      .insert(user)
      .values({ id: "alice", email: "alice@test.local", name: "Alice", roleId: "user" });
    const res = await DELETE(new Request("http://localhost"), ctxId("alice"));
    expect(res.status).toBe(204);
    const after = await db.query.user.findFirst({ where: (u, { eq }) => eq(u.id, "alice") });
    expect(after).toBeUndefined();
  });

  it("returns 404 when the user does not exist", async () => {
    const res = await DELETE(new Request("http://localhost"), ctxId("missing"));
    expect(res.status).toBe(404);
  });

  it("refuses to delete the last admin (409 LAST_ADMIN)", async () => {
    const res = await DELETE(new Request("http://localhost"), ctxId(TEST_USER.id));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("LAST_ADMIN");
  });

  it("allows deleting an admin when another admin exists", async () => {
    await db.insert(user).values({
      id: "second-admin",
      email: "second@test.local",
      name: "Second",
      roleId: "admin",
    });
    const res = await DELETE(new Request("http://localhost"), ctxId(TEST_USER.id));
    expect(res.status).toBe(204);
    const after = await db.query.user.findFirst({
      where: (u, { eq }) => eq(u.id, TEST_USER.id),
    });
    expect(after).toBeUndefined();
  });

  it("sweeps per-thread checkpointer rows + memory profile before the FK cascade", async () => {
    await db
      .insert(user)
      .values({ id: "alice", email: "alice@test.local", name: "Alice", roleId: "user" });
    await db.insert(threads).values([
      { id: "a-t1", userId: "alice" },
      { id: "a-t2", userId: "alice" },
    ]);
    const res = await DELETE(new Request("http://localhost"), ctxId("alice"));
    expect(res.status).toBe(204);
    expect(mockCheckpointDelete).toHaveBeenCalledTimes(2);
    expect(mockCheckpointDelete).toHaveBeenCalledWith("a-t1");
    expect(mockCheckpointDelete).toHaveBeenCalledWith("a-t2");
    expect(mockDeleteMemoryDoc).toHaveBeenCalledWith("alice");
    expect(
      await db.query.user.findFirst({ where: (u, { eq }) => eq(u.id, "alice") }),
    ).toBeUndefined();
  });
});
