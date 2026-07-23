import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/with-auth";
import { checkCredit } from "@/lib/credit/check";
import { getUserUsageSummary } from "@/lib/credit/user-stats";

// ponytail: rule #9 — withAuth wraps the handler. Same auth shape as
// /api/credit/history (signed-in user reads their own status only).
//
// Response shape:
//   { used, limit, windowHours, resetAt, unlimited, roleName, todayCredits, ... }
export const GET = withAuth(async (_req, { user }) => {
  const [status, usage] = await Promise.all([checkCredit(user.id), getUserUsageSummary(user.id)]);
  const unlimited = !Number.isFinite(status.limit);
  return NextResponse.json({
    used: status.used,
    limit: unlimited ? null : status.limit,
    windowHours: status.limit > 0 && !unlimited ? status.windowHours : null,
    resetAt: status.resetAt.toISOString(),
    unlimited,
    roleName: status.roleName,
    ...usage,
  });
});
