import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { db } from "@/db/client";
import { role, user } from "@/lib/auth/schema";
import { eq } from "drizzle-orm";

describe("Phase 1 schema", () => {
  // ponytail: other test files (admin/roles) wipe the role table in
  // beforeEach and re-insert only admin/user — leaving 'guest' missing.
  // Re-seed all three idempotently so these assertions are stable.
  beforeAll(async () => {
    await db
      .insert(role)
      .values([
        { id: "guest", name: "Guest", creditLimit: 20, windowHours: 24 },
        { id: "user", name: "User", creditLimit: 200, windowHours: 24 },
        { id: "admin", name: "Admin", creditLimit: null, windowHours: 24 },
      ])
      .onConflictDoNothing();
  });

  afterAll(async () => {
    // Pool closes at process exit; nothing to do here.
  });

  it("role table has the seeded rows", async () => {
    const rows = await db.select().from(role);
    const ids = rows.map((r) => r.id).sort();
    // ponytail: assert presence of the contract rows; the table may
    // also hold extra rows from manual dev DB tinkering (past
    // sessions have left `vip` etc. behind). Seed list: admin, guest,
    // user.
    expect(ids).toEqual(expect.arrayContaining(["admin", "guest", "user"]));
  });

  it("guest row has window_hours=24", async () => {
    const [row] = await db.select().from(role).where(eq(role.id, "guest"));
    expect(row.windowHours).toBe(24);
  });

  it("user row has window_hours=24", async () => {
    // ponytail: credit_limit is read-not-asserted here because other
    // test files overwrite it in their beforeEach. windowHours is
    // part of the schema contract (24h default), so we do assert it.
    const [row] = await db.select().from(role).where(eq(role.id, "user"));
    expect(row.windowHours).toBe(24);
  });

  it("admin row has credit_limit=null (unlimited signal)", async () => {
    const [row] = await db.select().from(role).where(eq(role.id, "admin"));
    expect(row.creditLimit).toBeNull();
    expect(row.windowHours).toBe(24);
  });

  it("user.role_id defaults to 'user' when not specified", async () => {
    // Probe the column default by inspecting drizzle's column metadata
    // rather than inserting a row (Better Auth owns the row writes).
    const col = (user as unknown as { roleId: { default: unknown } }).roleId;
    // pg-core stores the default as a SQL fragment in `.default`; we just
    // assert it's the string 'user' (not a function/SQL expression).
    const def = (col.default as { value?: string } | string | undefined) ?? undefined;
    const actual = typeof def === "string" ? def : def?.value;
    expect(actual).toBe("user");
  });
});
