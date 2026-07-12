import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/with-auth";
import { checkCredit } from "@/lib/credit/check";

// ponytail: rule #9 — withAuth wraps the handler. Same auth shape as
// /api/credit/history (signed-in user reads their own status only).
//
// Response shape:
//   { used, limit, windowHours, resetAt, unlimited }
// `unlimited: true` collapses `limit` to Number.POSITIVE_INFINITY —
// admin role skips the SUM and surfaces the all-clear on the UI.
// `resetAt` is the wall-clock instant when the OLDEST call in the
// rolling window ages out; "limit resets" reads better than
// "window starts" on the chat surface.
export const GET = withAuth(async (_req, { user }) => {
  const status = await checkCredit(user.id);
  const unlimited = !Number.isFinite(status.limit);
  return NextResponse.json({
    used: status.used,
    limit: unlimited ? null : status.limit,
    windowHours: status.limit > 0 && !unlimited ? status.windowHours : null,
    resetAt: status.resetAt.toISOString(),
    unlimited,
    roleName: status.roleName,
  });
});
