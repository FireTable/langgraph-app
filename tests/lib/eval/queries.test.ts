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
    expect(first.templateId).toBe("tmpl_chat_v1");
    expect(first.variantId).toBe("var_chat_control");
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
      templateId: "tmpl_chat_v1",
      variantId: "var_chat_control",
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
      templateId: "tmpl_chat_v1",
      variantId: "var_chat_control",
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
      templateId: "tmpl_chat_v1",
      variantId: "var_chat_control",
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
