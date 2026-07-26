import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withAuth } from "@/lib/auth/with-auth";
import { evalRun, evalRubric } from "@/lib/eval/schema";
import { threads } from "@/lib/threads/schema";
import { langGraphClient } from "@/lib/langgraph/client";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";

export const POST = withAuth(async (req, { user }) => {
  try {
    const body = (await req.json()) as { runId?: string; rubricId?: string };

    if (!body.runId) {
      return NextResponse.json({ error: "runId is required" }, { status: 400 });
    }

    const runs = await db.select().from(evalRun).where(eq(evalRun.id, body.runId)).limit(1);
    if (runs.length === 0) {
      return NextResponse.json({ error: "evalRun not found" }, { status: 404 });
    }
    const run = runs[0]!;

    const rubricId = body.rubricId ?? "rubric_default";
    const rubrics = await db.select().from(evalRubric).where(eq(evalRubric.id, rubricId)).limit(1);
    const rubric = rubrics[0] ?? {
      id: "rubric_default",
      name: "Default Agent Evaluation Rubric",
      criteria: [
        { key: "relevance", description: "Answer addresses user query accurately." },
        { key: "accuracy", description: "Answer is factually correct." },
      ],
    };

    // Observability Thread ID (UUID v4) & Parent Message ID (UUID v4) for this AI Judge run
    const judgeThreadId = randomUUID();
    const judgeParentMessageId = randomUUID();

    await db
      .insert(threads)
      .values({ id: judgeThreadId, userId: user.id, title: "AI Judge Run", kind: "eval-judge" })
      .onConflictDoNothing();

    try {
      await langGraphClient.threads.create({
        threadId: judgeThreadId,
        ifExists: "do_nothing",
      });
    } catch {
      // Ignore if local dev server without langgraph server
    }

    const input = {
      mode: "judge" as const,
      runId: run.id,
      rubricId: rubric.id,
    };

    const config = {
      configurable: {
        userId: user.id,
        thread_id: judgeThreadId,
        user_id: user.id,
      },
    };

    const metadata = {
      parent_message_id: judgeParentMessageId,
      thread_id: judgeThreadId,
      user_id: user.id,
    };

    const judgeResult = await langGraphClient.runs.wait(judgeThreadId, "evalAgent", {
      input,
      config,
      metadata,
    });

    return NextResponse.json({ result: judgeResult, judgeThreadId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
