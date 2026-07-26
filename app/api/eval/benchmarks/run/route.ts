import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/db/client";
import { withAuth } from "@/lib/auth/with-auth";
import { evalBenchmark } from "@/lib/eval/schema";
import { threads as threadTable } from "@/lib/threads/schema";
import { langGraphClient } from "@/lib/langgraph/client";

export const runtime = "nodejs";

export const POST = withAuth(async (req, { user }) => {
  try {
    const body = (await req.json()) as { benchmarkId?: string };
    if (!body.benchmarkId) {
      return NextResponse.json({ error: "benchmarkId is required" }, { status: 400 });
    }

    const rows = await db
      .select()
      .from(evalBenchmark)
      .where(eq(evalBenchmark.id, body.benchmarkId))
      .limit(1);
    if (rows.length === 0) {
      return NextResponse.json({ error: "Benchmark not found" }, { status: 404 });
    }
    const benchmark = rows[0];

    // ponytail: server-side resolution happens here so evalAgent doesn't
    // need to know about eval_benchmark at all. The graph just receives
    // { mode:"benchmark", targetAgent, inputPrompt, expectedOutput,
    // rubricId } and orchestrates the rest. Returning rubricId is an
    // explicit override — caller usually lets the graph default
    // (`rubric_${targetAgent}`) by leaving it undefined.
    const input = {
      mode: "benchmark" as const,
      benchmarkId: benchmark.id,
      targetAgent: benchmark.agent,
      inputPrompt: benchmark.inputPrompt,
      expectedOutput: benchmark.expectedOutput ?? undefined,
    };

    // ponytail: judge thread is registered up-front so the route can
    // surface judgeThreadId in the response — keeps the Online
    // Executions trace link working even though the benchmark mode
    // doesn't itself create a long-lived thread.
    const judgeThreadId = randomUUID();
    const judgeParentMessageId = randomUUID();
    await db
      .insert(threadTable)
      .values({
        id: judgeThreadId,
        userId: user.id,
        title: "AI Judge Run",
        kind: "eval-benchmark",
      })
      .onConflictDoNothing();
    try {
      await langGraphClient.threads.create({
        threadId: judgeThreadId,
        ifExists: "do_nothing",
      });
    } catch {
      // local dev server without langgraph server
    }

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

    const judgeResult = (await langGraphClient.runs.wait(judgeThreadId, "evalAgent", {
      input,
      config,
      metadata,
    })) as
      | {
          runId?: string;
          status?: string;
          errorMessage?: string | null;
        }
      | undefined;

    if (!judgeResult) {
      return NextResponse.json({ error: "Judge run returned no result" }, { status: 500 });
    }

    // ponytail: evalAgent.process returns the partial state accumulated
    // at the END node — runId flows back as the only stable identifier
    // for the benchmark invocation.
    return NextResponse.json({
      runId: judgeResult.runId ?? null,
      judgeThreadId,
      result: {
        status: judgeResult.status ?? "completed",
        errorMessage: judgeResult.errorMessage ?? null,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
