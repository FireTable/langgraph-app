import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/with-auth";
import { getThreadForUser } from "@/lib/threads/queries";
import { langGraphClient } from "@/lib/langgraph/client";
import { db } from "@/db/client";
import { observabilitySpans } from "@/lib/observability/schema";
import { and, eq } from "drizzle-orm";
import type { CapturedSpan } from "@/lib/observability/callback";

type Params = { id: string; parentMessageId: string; spanId: string };

// ponytail: rule #9 — every app/api/** route goes through withAuth.
// Single-span detail endpoint, called from the panel when the user clicks
// a waterfall row. Returns the full CapturedSpan so SpanDetails can render
// input / output / usage / meta without the bulk payload sitting in the
// parent route's response.
//
// ponytail: parentMessageId in the path is the disambiguator. The waterfall
// shows rows across the whole thread, and span_ids (LangChain runIds) can
// legitimately overlap conceptually between turns (e.g. a regenerate + the
// original both end with the same model call). Forcing the panel to send
// the turn it belongs to means a stale SDK fallback can't accidentally
// surface a run from a different turn. The DB query is `(thread_id,
// parent_message_id, span_id)` — uses the existing
// `observability_spans_thread_parent_started_idx` btree.
//
// ponytail: legacy rows with `parent_message_id` column still NULL get
// backfilled in bulkInsertSpans (queries.ts) so by read time every row
// has the column populated. If a NULL does slip through (retention cron
// + pre-backfill capture), the WHERE misses it and the SDK fallback
// takes over — acceptable since the row would be a 404 otherwise.
export const GET = withAuth<Params>(async (_req, { user, params }) => {
  const thread = await getThreadForUser(params.id, user.id);
  if (!thread) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });

  const local = await lookupLocalSpan(params.id, params.parentMessageId, params.spanId);
  if (local) {
    return NextResponse.json({
      thread_id: params.id,
      span: local,
    });
  }

  const sdkSpan = await lookupSdkSpan(params.id, params.parentMessageId, params.spanId);
  if (sdkSpan) {
    return NextResponse.json({
      thread_id: params.id,
      span: sdkSpan,
    });
  }

  return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
});

async function lookupLocalSpan(
  threadId: string,
  parentMessageId: string,
  spanId: string,
): Promise<CapturedSpan | null> {
  const rows = await db
    .select()
    .from(observabilitySpans)
    .where(
      and(
        eq(observabilitySpans.threadId, threadId),
        eq(observabilitySpans.parentMessageId, parentMessageId),
        eq(observabilitySpans.spanId, spanId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // ponytail: re-hydrate meta.parent_message_id from the column so the
  // panel renderers + transform layer keep working with the original
  // meta shape (they pre-date the column promotion).
  const meta = (row.meta as Record<string, unknown> | null | undefined) ?? {};
  const metaWithPmid = meta.parent_message_id
    ? meta
    : row.parentMessageId
      ? { ...meta, parent_message_id: row.parentMessageId }
      : meta;
  return {
    span_id: row.spanId,
    parent_span_id: row.parentSpanId,
    name: row.name,
    kind: row.kind,
    status: row.status,
    started_at: row.startedAt,
    ended_at: row.endedAt,
    input: row.input,
    output: row.output,
    usage: row.usage as Record<string, unknown> | null,
    error: row.error,
    meta: metaWithPmid,
  };
}

async function lookupSdkSpan(
  threadId: string,
  parentMessageId: string,
  spanId: string,
): Promise<CapturedSpan | null> {
  // ponytail: the SDK doesn't have a "get one run" — list everything
  // running/pending on the thread and find the matching run_id. Only
  // walks the in-process state (typically a handful of entries) so
  // it's cheap. We filter by metadata.parent_message_id matching the
  // path so a concurrent run from a different turn can't impersonate
  // the requested span_id.
  for (const status of ["running", "pending"] as const) {
    const runs = await langGraphClient.runs.list(threadId, { status });
    const run = runs.find(
      (r) =>
        r.run_id === spanId &&
        (r.metadata as Record<string, unknown> | null | undefined)?.parent_message_id ===
          parentMessageId,
    );
    if (!run) continue;
    return {
      span_id: run.run_id,
      parent_span_id: null,
      name: run.assistant_id,
      kind: "chain",
      status: run.status === "pending" ? "running" : "running",
      started_at: Date.parse(run.created_at) || Date.now(),
      ended_at: null,
      input: null,
      output: null,
      usage: null,
      error: null,
      meta: {
        run_id: run.run_id,
        thread_id: run.thread_id,
        assistant_id: run.assistant_id,
        ...run.metadata,
      },
    };
  }
  return null;
}
