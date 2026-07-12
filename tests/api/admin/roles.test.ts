import "@/tests/helpers/session";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { db } from "@/db/client";
import { role, user } from "@/lib/auth/schema";
import { setCurrentUser } from "@/tests/helpers/session";
import { TEST_USER } from "@/tests/helpers/auth";

import { GET, POST } from "@/app/api/admin/roles/route";
import { PATCH, DELETE } from "@/app/api/admin/roles/[id]/route";

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

beforeEach(async () => {
  // ponytail: keep `admin`/`user` role rows alive — deleting them would
  // orphan the test user whose FK points at role.id. Only nuke the rows
  // we OWN (the throwaway "vip" / custom ones) and re-insert admin/user
  // first so the FK target exists when we re-insert the user. Wipe
  // every test-owned user row first so the FK is empty when we drop role.
  await db.delete(user);
  await db.delete(role);
  await db
    .insert(role)
    .values([
      { id: "admin", name: "Admin", creditLimit: null, windowHours: 24 },
      { id: "user", name: "User", creditLimit: 100, windowHours: 24 },
    ])
    .onConflictDoNothing();
  await db
    .insert(user)
    .values({ id: TEST_USER.id, email: TEST_USER.email, name: "Test Owner", roleId: "admin" })
    .onConflictDoNothing();
  setCurrentUser(ADMIN);
});

afterAll(async () => {
  setCurrentUser(null);
});

// Local helper so we don't pull eq into the top-level imports when only
// this file needs it. Equivalent to drizzle's `eq`.
import { eq } from "drizzle-orm";

describe("GET /api/admin/roles", () => {
  it("returns 401 when unauthenticated", async () => {
    setCurrentUser(null);
    const res = await GET(new Request("http://localhost"), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when role is 'user'", async () => {
    setCurrentUser({ id: TEST_USER.id, email: TEST_USER.email, roleId: "user" });
    const res = await GET(new Request("http://localhost"), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 200 with all roles when admin", async () => {
    await db
      .insert(role)
      .values([
        { id: "user", name: "User", creditLimit: 100, windowHours: 24 },
        { id: "admin", name: "Admin", creditLimit: null, windowHours: 24 },
      ])
      .onConflictDoNothing();
    const res = await GET(new Request("http://localhost"), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.roles).toHaveLength(2);
  });
});

describe("POST /api/admin/roles", () => {
  it("creates a role with null creditLimit (unlimited)", async () => {
    const res = await POST(
      jsonRequest({
        id: "vip",
        name: "VIP",
        creditLimit: null,
        windowHours: 24,
      }),
      ctx,
    );
    expect(res.status).toBe(201);
    const row = await db.query.role.findFirst({ where: (r, { eq }) => eq(r.id, "vip") });
    expect(row).toBeDefined();
    expect(row!.creditLimit).toBeNull();
  });

  it("returns 400 on missing required fields", async () => {
    const res = await POST(jsonRequest({ id: "x" }), ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid id format", async () => {
    const res = await POST(
      jsonRequest({ id: "Bad Id!", name: "X", creditLimit: null, windowHours: 24 }),
      ctx,
    );
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/admin/roles/[id]", () => {
  it("updates name / creditLimit / windowHours", async () => {
    await db
      .insert(role)
      .values({ id: "user", name: "Old", creditLimit: 100, windowHours: 24 })
      .onConflictDoNothing();
    const res = await PATCH(
      jsonRequest({ name: "New", creditLimit: 200, windowHours: 12 }),
      ctxId("user"),
    );
    expect(res.status).toBe(200);
    const row = await db.query.role.findFirst({ where: (r, { eq }) => eq(r.id, "user") });
    expect(row?.name).toBe("New");
    expect(row?.creditLimit).toBe(200);
    expect(row?.windowHours).toBe(12);
  });

  it("can set creditLimit to null (= unlimited)", async () => {
    await db
      .insert(role)
      .values({ id: "user", name: "X", creditLimit: 100, windowHours: 24 })
      .onConflictDoNothing();
    const res = await PATCH(jsonRequest({ creditLimit: null }), ctxId("user"));
    expect(res.status).toBe(200);
    const row = await db.query.role.findFirst({ where: (r, { eq }) => eq(r.id, "user") });
    expect(row?.creditLimit).toBeNull();
  });

  it("returns 400 on empty patch", async () => {
    await db
      .insert(role)
      .values({ id: "user", name: "X", creditLimit: 100, windowHours: 24 })
      .onConflictDoNothing();
    const res = await PATCH(jsonRequest({}), ctxId("user"));
    expect(res.status).toBe(400);
  });

  it("returns 404 when missing", async () => {
    const res = await PATCH(jsonRequest({ name: "X" }), ctxId("missing"));
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/admin/roles/[id]", () => {
  it("deletes a role that no user references", async () => {
    await db
      .insert(role)
      .values({ id: "vip", name: "VIP", creditLimit: null, windowHours: 24 })
      .onConflictDoNothing();
    const res = await DELETE(new Request("http://localhost"), ctxId("vip"));
    expect(res.status).toBe(204);
    const row = await db.query.role.findFirst({ where: (r, { eq }) => eq(r.id, "vip") });
    expect(row).toBeUndefined();
  });

  it("returns 409 when a user still references the role", async () => {
    await db
      .insert(role)
      .values({ id: "user", name: "User", creditLimit: 100, windowHours: 24 })
      .onConflictDoNothing();
    await db.insert(user).values({ id: "alice", email: "a@x.test", roleId: "user" });
    const res = await DELETE(new Request("http://localhost"), ctxId("user"));
    expect(res.status).toBe(409);
    const row = await db.query.role.findFirst({ where: (r, { eq }) => eq(r.id, "user") });
    expect(row).toBeDefined();
  });

  it("returns 404 when missing", async () => {
    const res = await DELETE(new Request("http://localhost"), ctxId("missing"));
    expect(res.status).toBe(404);
  });
});

void randomUUID;
