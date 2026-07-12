import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { user, role } from "@/lib/auth/schema";
import { checkCredit } from "@/lib/credit/check";
import { computeCredits, recordLlmCall } from "@/lib/credit/charge";
import { randomUUID } from "node:crypto";

// ponytail: integration test — needs a real DB. The globalSetup in
// tests/setup.ts already migrates the test DB; these tests insert +
// delete their own fixture rows so they don't interfere with other tests.
describe("checkCredit + recordLlmCall integration", () => {
  const testUserIds: string[] = [];

  // ponytail: other test files (admin/roles) wipe the role table in
  // beforeEach — their cleanup deletes the seeded admin/user/guest rows
  // and they re-insert with different values. Re-seed idempotently here
  // so checkCredit can find a role row when it does the FK join.
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
    // Cleanup fixture rows. credit_usage_log cascades from user delete.
    for (const id of testUserIds) {
      await db.delete(user).where(eq(user.id, id));
    }
  });

  async function makeUser(roleId: "admin" | "user" | "guest") {
    const id = randomUUID();
    await db.insert(user).values({
      id,
      email: `${id}@test.local`,
      roleId,
    });
    testUserIds.push(id);
    return id;
  }

  it("admin role: creditLimit IS NULL → unlimited (allowed, no SUM)", async () => {
    const userId = await makeUser("admin");
    const status = await checkCredit(userId);
    expect(status.allowed).toBe(true);
    expect(status.limit).toBe(Number.POSITIVE_INFINITY);
  });

  it("user role: under cap → allowed", async () => {
    const userId = await makeUser("user");
    const status = await checkCredit(userId);
    expect(status.allowed).toBe(true);
    // ponytail: read the limit from DB rather than hardcoding — other
    // test files (admin/roles) overwrite the seeded role row values
    // in their beforeEach, and check.test.ts must work regardless.
    const [{ creditLimit }] = await db
      .select({ creditLimit: role.creditLimit })
      .from(role)
      .where(eq(role.id, "user"));
    expect(status.limit).toBe(creditLimit);
    expect(status.used).toBe(0);
  });

  it("user role: at cap → not allowed, resetAt computed from oldest in-window call", async () => {
    const userId = await makeUser("user");
    const rate = { inputPer1k: 1, outputPer1k: 1 };
    for (let i = 0; i < 200; i++) {
      await recordLlmCall({
        userId,
        providerId: "openai",
        modelName: "gpt-4o-mini",
        agentName: "test",
        usage: { input: 1000, output: 0 },
        status: "success",
        credits: computeCredits({ input: 1000, output: 0 }, rate),
      });
    }
    const status = await checkCredit(userId);
    expect(status.allowed).toBe(false);
    expect(status.used).toBeGreaterThanOrEqual(200);
    expect(status.resetAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("error-status rows do not count toward cap", async () => {
    const userId = await makeUser("user");
    for (let i = 0; i < 50; i++) {
      await recordLlmCall({
        userId,
        providerId: "openai",
        modelName: "gpt-4o-mini",
        agentName: "test",
        usage: { input: 1000, output: 0 },
        status: "error",
        credits: 0,
      });
    }
    const status = await checkCredit(userId);
    expect(status.used).toBe(0);
    expect(status.allowed).toBe(true);
  });

  it("guest role: lower cap (20)", async () => {
    const userId = await makeUser("guest");
    const status = await checkCredit(userId);
    expect(status.limit).toBe(20);
  });
});
