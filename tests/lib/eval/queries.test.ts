import "@/tests/helpers/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  promptTemplate,
  promptVariant,
  promptVariantAssignment,
  evalRun,
  evalFeedback,
  evalJudgment,
  evalRubric,
} from "@/lib/eval/schema";
import {
  seedInitialPrompts,
  assignPromptVariant,
  recordEvalRun,
  submitFeedback,
  saveJudgment,
} from "@/lib/eval/queries";
import { threads } from "@/lib/threads/schema";
import { ensureTestUser, TEST_USER, cleanupUsers } from "@/tests/helpers/auth";
import { generateId } from "@/lib/ids/nanoid";

beforeEach(async () => {
  await ensureTestUser();
});

afterEach(async () => {
  await db.delete(evalFeedback).where(eq(evalFeedback.userId, TEST_USER.id));
  await db.delete(evalJudgment);
  await db.delete(evalRun).where(eq(evalRun.userId, TEST_USER.id));
  await db.delete(promptVariantAssignment).where(eq(promptVariantAssignment.userId, TEST_USER.id));
  await db.delete(threads).where(eq(threads.userId, TEST_USER.id));
  await cleanupUsers();
});

async function createTestThread(): Promise<string> {
  const id = `thread-${generateId()}`;
  await db.insert(threads).values({
    id,
    userId: TEST_USER.id,
    title: "Test Thread",
  });
  return id;
}

describe("lib/eval/queries — seedInitialPrompts", () => {
  it("seeds initial prompt templates and default rubric idempotently", async () => {
    await seedInitialPrompts();
    // Run second time to verify idempotency
    await seedInitialPrompts();

    const templates = await db.select().from(promptTemplate);
    expect(templates.length).toBeGreaterThanOrEqual(2);

    const variants = await db.select().from(promptVariant);
    expect(variants.length).toBeGreaterThanOrEqual(2);

    const rubrics = await db.select().from(evalRubric).where(eq(evalRubric.id, "rubric_default"));
    expect(rubrics).toHaveLength(1);
  });
});

describe("lib/eval/queries — assignPromptVariant", () => {
  it("assigns a variant and remains sticky for the same user", async () => {
    await seedInitialPrompts();
    const first = await assignPromptVariant(TEST_USER.id, "chatAgent");
    expect(first.templateId).toBe("tmpl_chatAgent_v1");
    expect(first.variantId).toBe("var_chatAgent_default");
    expect(first.content).toBeTruthy();

    const second = await assignPromptVariant(TEST_USER.id, "chatAgent");
    expect(second.variantId).toBe(first.variantId);
  });
});

describe("lib/eval/queries — recordEvalRun", () => {
  it("inserts an eval_run row correctly", async () => {
    await seedInitialPrompts();
    const threadId = await createTestThread();

    const run = await recordEvalRun({
      threadId,
      userId: TEST_USER.id,
      agent: "chatAgent",
      templateId: "tmpl_chatAgent_v1",
      variantId: "var_chatAgent_default",
      totalMs: 450,
      status: "success",
      inputTokens: 100,
      outputTokens: 50,
      parentMessageId: "msg_123",
    });

    expect(run.id).toBeTruthy();
    expect(run.threadId).toBe(threadId);
    expect(run.totalMs).toBe(450);

    const fetched = await db.select().from(evalRun).where(eq(evalRun.id, run.id));
    expect(fetched).toHaveLength(1);
    expect(fetched[0].parentMessageId).toBe("msg_123");
  });
});

describe("lib/eval/queries — submitFeedback", () => {
  it("submits 1-5 rating feedback for a run", async () => {
    await seedInitialPrompts();
    const threadId = await createTestThread();

    const run = await recordEvalRun({
      threadId,
      userId: TEST_USER.id,
      agent: "chatAgent",
      templateId: "tmpl_chatAgent_v1",
      variantId: "var_chatAgent_default",
      totalMs: 300,
      status: "success",
    });

    await submitFeedback({
      runId: run.id,
      userId: TEST_USER.id,
      source: "user_online",
      rating: 5,
      reason: "Great answer!",
    });

    const fb = await db.select().from(evalFeedback).where(eq(evalFeedback.runId, run.id));
    expect(fb).toHaveLength(1);
    expect(fb[0].rating).toBe(5);
    expect(fb[0].source).toBe("user_online");
  });
});

describe("lib/eval/queries — saveJudgment", () => {
  it("saves AI judgment scores for a run", async () => {
    await seedInitialPrompts();
    const threadId = await createTestThread();

    const run = await recordEvalRun({
      threadId,
      userId: TEST_USER.id,
      agent: "chatAgent",
      templateId: "tmpl_chatAgent_v1",
      variantId: "var_chatAgent_default",
      totalMs: 300,
      status: "success",
    });

    await saveJudgment({
      runId: run.id,
      rubricId: "rubric_default",
      scores: { relevance: 5, accuracy: 4 },
      reasoning: "Accurate and relevant response.",
      totalCostTokens: 150,
    });

    const judgments = await db.select().from(evalJudgment).where(eq(evalJudgment.runId, run.id));
    expect(judgments).toHaveLength(1);
    expect(judgments[0].scores).toEqual({ relevance: 5, accuracy: 4 });
  });
});

describe("lib/eval/queries — getRunsByAgentPage", () => {
  it("paginates newest-first per agent with stable hasMore + cursor", async () => {
    await seedInitialPrompts();
    const threadId = await createTestThread();

    const { getRunsByAgentPage } = await import("@/lib/eval/queries");

    const insertedIds: string[] = [];
    for (let i = 0; i < 7; i++) {
      const run = await recordEvalRun({
        threadId,
        userId: TEST_USER.id,
        agent: "chatAgent",
        templateId: "tmpl_chatAgent_v1",
        variantId: "var_chatAgent_default",
        totalMs: 100 + i,
        status: "success",
      });
      insertedIds.push(run.id);
    }

    const other = await recordEvalRun({
      threadId,
      userId: TEST_USER.id,
      agent: "weatherAgent",
      templateId: "tmpl_chatAgent_v1",
      variantId: "var_chatAgent_default",
      totalMs: 50,
      status: "success",
    });

    // First page: 5 rows, hasMore, nextCursor set
    const page1 = await getRunsByAgentPage({ agent: "chatAgent", limit: 5 });
    expect(page1.runs).toHaveLength(5);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursorId).toBe(page1.runs[page1.runs.length - 1]!.id);

    // page1.runs must be a strict suffix of newest seven — every id
    // present, none from the weatherAgent row
    const page1Ids = new Set(page1.runs.map((r) => r.id));
    for (const id of insertedIds.slice(-5)) {
      expect(page1Ids.has(id)).toBe(true);
    }
    expect(page1Ids.has(other.id)).toBe(false);

    // Second page from cursor: gets the remaining 2, hasMore=false
    const page2 = await getRunsByAgentPage({
      agent: "chatAgent",
      cursorId: page1.nextCursorId,
      limit: 5,
    });
    expect(page2.runs).toHaveLength(2);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursorId).toBeNull();

    const page2Ids = new Set(page2.runs.map((r) => r.id));
    for (const id of insertedIds.slice(0, 2)) {
      expect(page2Ids.has(id)).toBe(true);
    }
  });

  it("defaults the limit to 5 when zero or NaN", async () => {
    await seedInitialPrompts();
    const threadId = await createTestThread();
    const { getRunsByAgentPage } = await import("@/lib/eval/queries");

    for (let i = 0; i < 8; i++) {
      await recordEvalRun({
        threadId,
        userId: TEST_USER.id,
        agent: "chatAgent",
        templateId: "tmpl_chatAgent_v1",
        variantId: "var_chatAgent_default",
        totalMs: 100,
        status: "success",
      });
    }

    const pageZero = await getRunsByAgentPage({ agent: "chatAgent", limit: 0 });
    expect(pageZero.runs).toHaveLength(5);
    expect(pageZero.hasMore).toBe(true);

    const pageNaN = await getRunsByAgentPage({
      agent: "chatAgent",
      limit: Number.NaN as unknown as number,
    });
    expect(pageNaN.runs).toHaveLength(5);
  });

  it("clamps oversized limits to the 50 ceiling", async () => {
    await seedInitialPrompts();
    const threadId = await createTestThread();
    const { getRunsByAgentPage } = await import("@/lib/eval/queries");

    for (let i = 0; i < 3; i++) {
      await recordEvalRun({
        threadId,
        userId: TEST_USER.id,
        agent: "chatAgent",
        templateId: "tmpl_chatAgent_v1",
        variantId: "var_chatAgent_default",
        totalMs: 100,
        status: "success",
      });
    }

    const page = await getRunsByAgentPage({ agent: "chatAgent", limit: 9999 });
    expect(page.runs.length).toBeLessThanOrEqual(50);
  });

  it("returns an empty page for an agent with no runs", async () => {
    const { getRunsByAgentPage } = await import("@/lib/eval/queries");
    const page = await getRunsByAgentPage({ agent: "noSuchAgent", limit: 5 });
    expect(page.runs).toHaveLength(0);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursorId).toBeNull();
  });
});
