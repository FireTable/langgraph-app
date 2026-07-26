import { NextResponse } from "next/server";
import { avg, count, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withAuth } from "@/lib/auth/with-auth";
import { evalRun, evalFeedback, promptVariant } from "@/lib/eval/schema";
import { getRunsByAgentPage } from "@/lib/eval/queries";

export const runtime = "nodejs";

const PAGE_SIZE = 5;

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

    // ponytail: distinct agents with rows, then per-agent pagination.
    // The previous global limit(50) hid runs beyond the most recent 50.
    // Now each agent gets PAGE_SIZE rows + a cursor so the UI can keep
    // walking older history on demand. Agents with no rows are omitted;
    // the client renders an empty placeholder for them.
    const agentRows = await db.selectDistinct({ agent: evalRun.agent }).from(evalRun);

    const hasMore: Record<string, boolean> = {};
    const nextCursor: Record<string, string | null> = {};
    type PageShape = Awaited<ReturnType<typeof getRunsByAgentPage>>["runs"];
    const runsByAgent: Record<string, PageShape> = {};

    // ponytail: parallelise the per-agent lookups instead of awaiting in a
    // hot loop. With ten LANGGRAPH agents each doing a small LIMIT+1 query,
    // serial awaited latency dominates page load.
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
