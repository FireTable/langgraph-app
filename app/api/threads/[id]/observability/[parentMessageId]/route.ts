import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/with-auth";
import { getThreadForUser } from "@/lib/threads/queries";
import { getSpansByThreadId, markRunningAsFailed } from "@/lib/observability/queries";
import { getRetentionDays } from "@/lib/observability/config";

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
  const spans = await getSpansByThreadId(params.id, {
    parentMessageId: params.parentMessageId,
  });
  return NextResponse.json({
    thread_id: params.id,
    retention_days: getRetentionDays(),
    parent_message_id: params.parentMessageId,
    spans,
  });
});
