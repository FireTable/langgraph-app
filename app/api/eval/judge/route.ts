import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withAuth } from "@/lib/auth/with-auth";
import { evalRun, evalRubric } from "@/lib/eval/schema";
import { graph as evalAgentGraph } from "@/backend/agent/eval-agent";
import { langGraphClient } from "@/lib/langgraph/client";
import { generateId } from "@/lib/ids/nanoid";

export const runtime = "nodejs";

export const POST = withAuth(async (req) => {
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

    // Observability Thread ID for this AI Judge run (matches kbAgent ingest pattern)
    const judgeThreadId = `eval-judge-${generateId()}`;

    try {
      await langGraphClient.threads.create({
        threadId: judgeThreadId,
        ifExists: "do_nothing",
      });
    } catch {
      // Ignore if local dev server without langgraph server
    }

    // Invoke LLM-as-a-Judge Graph
    const judgeResult = await evalAgentGraph.invoke(
      {
        runId: run.id,
        rubricId: rubric.id,
        judgeThreadId,
      },
      {
        configurable: { thread_id: judgeThreadId },
      },
    );

    return NextResponse.json({ result: judgeResult, judgeThreadId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
