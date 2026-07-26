import { NextResponse } from "next/server";
import { and, avg, count, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withAuth } from "@/lib/auth/with-auth";
import { evalRun, evalFeedback, promptVariant } from "@/lib/eval/schema";
import { threads as threadTable } from "@/lib/threads/schema";
import { getRunsByAgentPage } from "@/lib/eval/queries";

export const runtime = "nodejs";

const PAGE_SIZE = 5;

// ponytail: Online Executions means "real production traffic" (threads
// created by the chat flow, kind='chat'). Benchmark runs write
// threads.kind='eval' — they belong on the Benchmark Datasets surface,
// never here. We filter via JOIN once at the route + paginated query
// level so the frontend never has to second-guess.
const chatRunWhere = and(eq(threadTable.kind, "chat"))!;

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
      .innerJoin(threadTable, eq(threadTable.id, evalRun.threadId))
      .where(chatRunWhere)
      .groupBy(evalRun.variantId, promptVariant.label);

    const agentRows = await db
      .selectDistinct({ agent: evalRun.agent })
      .from(evalRun)
      .innerJoin(threadTable, eq(threadTable.id, evalRun.threadId))
      .where(chatRunWhere);

    const hasMore: Record<string, boolean> = {};
    const nextCursor: Record<string, string | null> = {};
    type PageShape = Awaited<ReturnType<typeof getRunsByAgentPage>>["runs"];
    const runsByAgent: Record<string, PageShape> = {};

    const pages = await Promise.all(
      agentRows.map(({ agent }) =>
        getRunsByAgentPage({ agent, limit: PAGE_SIZE }).then((page) => ({ agent, page })),
      ),
    );

    for (const { agent, page } of pages) {
      if (page.runs.length === 0) continue;
      runsByAgent[agent] = page.runs;
      hasMore[agent] = page.hasMore;
      nextCursor[agent] = page.nextCursorId;
    }

    return NextResponse.json({
      stats: variantStats,
      runs: runsByAgent,
      pageSize: PAGE_SIZE,
      hasMore,
      nextCursor,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
