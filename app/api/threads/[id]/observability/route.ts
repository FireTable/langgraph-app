import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/with-auth";
import { getThreadForUser } from "@/lib/threads/queries";
import {
  getSpansByThreadId,
  markRunningAsFailed,
  deleteSpansByThreadId,
} from "@/lib/observability/queries";
import { getRetentionDays } from "@/lib/observability/config";
import { transformCapturedToSpanData, buildStepIdToRawSpanId } from "@/lib/observability/transform";
import { aggregateRoot } from "@/lib/observability/aggregate";

type IdParams = { id: string };

// ponytail: rule #9 — every app/api/** route goes through withAuth.
// Cross-user thread_id is 404 (not 401 / 403) so callers can't
// enumerate which thread ids exist. This endpoint returns ALL spans for
// the thread (no parent_message_id filter); the filtered variant is
// served from the sibling route file at
// app/api/threads/[id]/observability/[parentMessageId]/route.ts.
//
// ponytail: data shape — server-side only. Same shape as the filtered
// route but aggregate is computed across the whole thread (panel uses
// this as the "no specific turn" view, e.g. when the user opens the
// sheet from a message whose id isn't captured in any span).
export const GET = withAuth<IdParams>(async (_req, { user, params }) => {
  const thread = await getThreadForUser(params.id, user.id);
  if (!thread) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  await markRunningAsFailed(params.id);
  const capturedSpans = await getSpansByThreadId(params.id);
  const spans = transformCapturedToSpanData(capturedSpans);
  const aggregate = aggregateRoot(capturedSpans, spans);
  const stepIdToRawSpanId = buildStepIdToRawSpanId(capturedSpans);
  return NextResponse.json({
    thread_id: params.id,
    retention_days: getRetentionDays(),
    spans,
    aggregate,
    in_flight_runs: [],
    step_id_to_raw_span_id: stepIdToRawSpanId,
  });
});

export const DELETE = withAuth<IdParams>(async (_req, { user, params }) => {
  const thread = await getThreadForUser(params.id, user.id);
  if (!thread) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  const cleared = await deleteSpansByThreadId(params.id);
  return NextResponse.json({ cleared });
});
