import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/with-auth";
import { getThreadForUser } from "@/lib/threads/queries";
import {
  getSpansByThreadId,
  markRunningAsFailed,
  deleteSpansByThreadId,
} from "@/lib/observability/queries";
import { getRetentionDays } from "@/lib/observability/config";

type IdParams = { id: string };

// ponytail: rule #9 — every app/api/** route goes through withAuth.
// Cross-user thread_id is 404 (not 401 / 403) so callers can't
// enumerate which thread ids exist.
export const GET = withAuth<IdParams>(async (_req, { user, params }) => {
  const thread = await getThreadForUser(params.id, user.id);
  if (!thread) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  // ponytail: preflight flip — interrupted invokes leave Start-only
  // spans running forever; the panel would render "running" with no
  // end. Mark them failed before the client sees them.
  await markRunningAsFailed(params.id);
  const spans = await getSpansByThreadId(params.id);
  return NextResponse.json({
    thread_id: params.id,
    retention_days: getRetentionDays(),
    spans,
  });
});

export const DELETE = withAuth<IdParams>(async (_req, { user, params }) => {
  const thread = await getThreadForUser(params.id, user.id);
  if (!thread) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  const cleared = await deleteSpansByThreadId(params.id);
  return NextResponse.json({ cleared });
});
