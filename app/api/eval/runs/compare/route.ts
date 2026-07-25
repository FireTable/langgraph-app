import { NextResponse } from "next/server";
import { avg, count, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { withAuth } from "@/lib/auth/with-auth";
import { evalRun, evalFeedback, evalJudgment, promptVariant } from "@/lib/eval/schema";

export const runtime = "nodejs";

export const GET = withAuth(async () => {
  try {
    const variantStats = await db
      .select({
        variantId: evalRun.variantId,
        label: promptVariant.label,
        totalRuns: count(evalRun.id),
        avgTotalMs: avg(evalRun.totalMs),
        avgRating: avg(evalFeedback.rating),
      })
      .from(evalRun)
      .leftJoin(promptVariant, eq(evalRun.variantId, promptVariant.id))
      .leftJoin(evalFeedback, eq(evalRun.id, evalFeedback.runId))
      .groupBy(evalRun.variantId, promptVariant.label);

    const recentRuns = await db
      .select({
        id: evalRun.id,
        agent: evalRun.agent,
        variantId: evalRun.variantId,
        label: promptVariant.label,
        totalMs: evalRun.totalMs,
        status: evalRun.status,
        createdAt: evalRun.createdAt,
        userRating: evalFeedback.rating,
        threadId: evalRun.threadId,
        parentMessageId: evalRun.parentMessageId,
      })
      .from(evalRun)
      .leftJoin(promptVariant, eq(evalRun.variantId, promptVariant.id))
      .leftJoin(evalFeedback, eq(evalRun.id, evalFeedback.runId))
      .orderBy(sql`${evalRun.createdAt} DESC`)
      .limit(50);

    return NextResponse.json({
      stats: variantStats,
      recentRuns,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
