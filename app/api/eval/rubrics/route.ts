import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { withAuth } from "@/lib/auth/with-auth";
import { evalRubric, evalJudgment, evalRun } from "@/lib/eval/schema";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";

export const GET = withAuth(async () => {
  try {
    const rubrics = await db.select().from(evalRubric);
    const judgments = await db
      .select({
        id: evalJudgment.id,
        runId: evalJudgment.runId,
        rubricId: evalJudgment.rubricId,
        scores: evalJudgment.scores,
        reasoning: evalJudgment.reasoning,
        totalCostTokens: evalJudgment.totalCostTokens,
        judgeThreadId: evalJudgment.judgeThreadId,
        judgeParentMessageId: evalJudgment.judgeParentMessageId,
        createdAt: evalJudgment.createdAt,
        agent: evalRun.agent,
        variantId: evalRun.variantId,
      })
      .from(evalJudgment)
      .leftJoin(evalRun, eq(evalJudgment.runId, evalRun.id));

    return NextResponse.json({ rubrics, judgments });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});

export const POST = withAuth(async (req) => {
  try {
    const body = (await req.json()) as {
      id?: string;
      name?: string;
      criteria?: Array<{ name: string; description: string; weight: number }>;
    };

    if (!body.name || !body.criteria) {
      return NextResponse.json({ error: "name and criteria are required" }, { status: 400 });
    }

    const formattedCriteria = body.criteria.map((c) => ({
      key: c.name || (c as any).key || "criterion",
      description: c.description,
      weight: c.weight,
    }));

    const id = body.id || `rubric_${Date.now()}`;
    const existing = await db.select().from(evalRubric).where(eq(evalRubric.id, id)).limit(1);

    let saved;
    if (existing.length > 0) {
      saved = await db
        .update(evalRubric)
        .set({
          name: body.name,
          criteria: formattedCriteria,
          updatedAt: new Date(),
        })
        .where(eq(evalRubric.id, id))
        .returning();
    } else {
      saved = await db
        .insert(evalRubric)
        .values({
          id,
          name: body.name,
          criteria: formattedCriteria,
        })
        .returning();
    }

    return NextResponse.json({ rubric: saved[0] });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
