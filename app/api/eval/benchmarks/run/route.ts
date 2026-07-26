import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/with-auth";
import { BenchmarkNotFoundError, runBenchmark } from "@/lib/eval/benchmark-runner";

export const runtime = "nodejs";

export const POST = withAuth(async (req, { user }) => {
  try {
    const body = (await req.json()) as { benchmarkId?: string };
    if (!body.benchmarkId) {
      return NextResponse.json({ error: "benchmarkId is required" }, { status: 400 });
    }

    const { runId, threadId, judgeThreadId, result } = await runBenchmark({
      benchmarkId: body.benchmarkId,
      userId: user.id,
    });

    return NextResponse.json({ runId, threadId, judgeThreadId, result });
  } catch (err: unknown) {
    if (err instanceof BenchmarkNotFoundError) {
      return NextResponse.json({ error: "Benchmark not found" }, { status: 404 });
    }
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
