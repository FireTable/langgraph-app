import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/with-auth";
import { getThreadForUser } from "@/lib/threads/queries";
import { getSpansByThreadId, markRunningAsFailed } from "@/lib/observability/queries";
import { getRetentionDays } from "@/lib/observability/config";
import { langGraphClient } from "@/lib/langgraph/client";

type Params = { id: string; parentMessageId: string };

// ponytail: rule #9 — every app/api/** route goes through withAuth.
// Companion to app/api/threads/[id]/observability/route.ts — same
// auth + 404-on-cross-user contract; the only difference is the path
// carries the assistant-ui human-message id so the panel renders only
// the spans produced for THAT turn (see backend/observability/
// callback-collector.ts `currentParentMessageId`).
export const GET = withAuth<Params>(async (_req, { user, params }) => {
  const thread = await getThreadForUser(params.id, user.id);
  if (!thread) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  await markRunningAsFailed(params.id);
  // ponytail: the path is double-encoded upstream via Next.js route
  // params — no extra decoding needed, the value is already a clean
  // string when it reaches us. The btree index
  // observability_spans_thread_parent_started_idx serves this path.
  const [spans, inFlightRuns] = await Promise.all([
    getSpansByThreadId(params.id, {
      parentMessageId: params.parentMessageId,
    }),
    // ponytail: the persisted spans cover anything whose Start hook has
    // fired (CapturingHandler now persists on Start — see
    // backend/observability/callback-collector.ts). runs.list covers the
    // earlier window — runs enqueued by runs.create but whose first
    // callback hasn't fired yet — and surfaces pending vs running state
    // (the persisted row is stuck on "running" until End). Two SDK
    // calls because `list({status})` is single-valued; in practice the
    // pending set is empty most of the time.
    fetchInFlightRuns(params.id, params.parentMessageId),
  ]);
  return NextResponse.json({
    thread_id: params.id,
    retention_days: getRetentionDays(),
    parent_message_id: params.parentMessageId,
    spans,
    in_flight_runs: inFlightRuns,
  });
});

async function fetchInFlightRuns(threadId: string, parentMessageId: string): Promise<unknown[]> {
  // ponytail: main-agent runs are NOT stamped with parent_message_id
  // today — only bg-agent dispatches go through triggerBackgroundAgentNode
  // which sets metadata. So the filter matches bg runs only. The empty
  // array is still useful for the panel: it confirms "no bg in flight
  // on this turn" without a separate code path.
  const [running, pending] = await Promise.all([
    langGraphClient.runs.list(threadId, { status: "running" }),
    langGraphClient.runs.list(threadId, { status: "pending" }),
  ]);

  const all = [...running, ...pending];

  return all.filter((r) => r.metadata?.parent_message_id === parentMessageId);
}
