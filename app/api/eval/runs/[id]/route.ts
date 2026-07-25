import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withAuth } from "@/lib/auth/with-auth";
import { evalRun, evalFeedback, evalJudgment } from "@/lib/eval/schema";
import { observabilitySpans } from "@/db/schema";

export const runtime = "nodejs";

export const GET = withAuth<{ id: string }>(async (_req, ctx) => {
  try {
    const { id } = await ctx.params;

    const runs = await db.select().from(evalRun).where(eq(evalRun.id, id)).limit(1);
    if (runs.length === 0) {
      return NextResponse.json({ error: "evalRun not found" }, { status: 404 });
    }
    const run = runs[0]!;

    const feedbackList = await db.select().from(evalFeedback).where(eq(evalFeedback.runId, id));

    const judgments = await db.select().from(evalJudgment).where(eq(evalJudgment.runId, id));

    const spans = await db
      .select()
      .from(observabilitySpans)
      .where(eq(observabilitySpans.threadId, run.threadId))
      .limit(20);

    return NextResponse.json({
      run,
      feedback: feedbackList[0] || null,
      judgment: judgments[0] || null,
      spans,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
