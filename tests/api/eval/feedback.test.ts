import "@/tests/helpers/session";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { POST } from "@/app/api/eval/feedback/route";
import { db } from "@/db/client";
import { evalFeedback, evalRun } from "@/lib/eval/schema";
import { threads } from "@/lib/threads/schema";
import { recordEvalRun, seedInitialPrompts } from "@/lib/eval/queries";
import { setCurrentUser } from "@/tests/helpers/session";
import { ensureTestUser, TEST_USER, cleanupUsers } from "@/tests/helpers/auth";
import { generateId } from "@/lib/ids/nanoid";
import { eq } from "drizzle-orm";

beforeEach(async () => {
  await ensureTestUser();
  setCurrentUser(TEST_USER);
});

afterEach(async () => {
  await db.delete(evalFeedback).where(eq(evalFeedback.userId, TEST_USER.id));
  await db.delete(evalRun).where(eq(evalRun.userId, TEST_USER.id));
  await db.delete(threads).where(eq(threads.userId, TEST_USER.id));
  await cleanupUsers();
  setCurrentUser(null);
});

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/eval/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/eval/feedback", () => {
  it("returns 401 when user is unauthenticated", async () => {
    setCurrentUser(null);
    const req = jsonRequest({ runId: "r1", rating: 5 });
    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
  });

  it("returns 400 when runId or rating is missing", async () => {
    const req = jsonRequest({ rating: 5 });
    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it("submits feedback successfully (200)", async () => {
    await seedInitialPrompts();
    const threadId = `t-${generateId()}`;
    await db.insert(threads).values({ id: threadId, userId: TEST_USER.id, title: "Test" });

    const run = await recordEvalRun({
      threadId,
      userId: TEST_USER.id,
      agent: "chatAgent",
      templateId: "tmpl_chat_v1",
      variantId: "var_chat_control",
      totalMs: 300,
      status: "success",
    });

    const req = jsonRequest({ runId: run.id, rating: 5, source: "user_online", reason: "Good" });
    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { success?: boolean };
    expect(body.success).toBe(true);

    const fb = await db.select().from(evalFeedback).where(eq(evalFeedback.runId, run.id));
    expect(fb).toHaveLength(1);
    expect(fb[0].rating).toBe(5);
  });
});
