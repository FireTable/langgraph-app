import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { role, user } from "@/lib/auth/schema";
import { creditUsageLog } from "./schema";

export type CreditStatus = {
  allowed: boolean;
  used: number;
  limit: number; // Number.POSITIVE_INFINITY for unlimited
  windowHours: number; // 0 when unlimited (admin role)
  resetAt: Date;
  roleName: string;
};

// ponytail: calendar-aligned rolling window in **UTC** — the
// admin's view of the cap. Buckets are anchored at the Unix epoch,
// which lands on UTC midnight, so for windowHours=8 the boundaries
// are 00:00 / 08:00 / 16:00 UTC, for windowHours=24 it's 00:00 UTC.
// The SQL predicate `created_at >= windowStart` and the displayed
// resetAt (`windowStart + windowHours`) are computed from the same
// JS-side windowStart so they can't drift. **Display** renders the
// resetAt via `toLocaleTimeString` in each user's browser, so the
// same UTC 16:00 boundary reads as "16:00" for a UTC user, "00:00"
// for a UTC+8 user, "08:00" for a UTC-8 user — that's intentional
// and gives the user "their time" rather than the server's time.
//
// Admin role: creditLimit IS NULL → unlimited, skip the SUM entirely.
export async function checkCredit(userId: string): Promise<CreditStatus> {
  const [{ creditLimit, windowHours, roleName }] = await db
    .select({
      creditLimit: role.creditLimit,
      windowHours: role.windowHours,
      roleName: role.name,
    })
    .from(user)
    .innerJoin(role, eq(user.roleId, role.id))
    .where(eq(user.id, userId));

  if (creditLimit === null) {
    return {
      allowed: true,
      used: 0,
      limit: Number.POSITIVE_INFINITY,
      windowHours: 0,
      resetAt: new Date(),
      roleName,
    };
  }

  // UTC-anchored window floor: bucket Date.now() into N-hour buckets
  // from the Unix epoch. epoch=0 falls on a UTC midnight boundary,
  // so the floors land on 00:00 / 08:00 / 16:00 UTC for windowHours=8.
  // Display components render resetAt via toLocaleTimeString so the
  // user sees it in their own timezone, not the server's.
  const windowMs = windowHours * 60 * 60 * 1000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const resetAt = new Date(windowStart.getTime() + windowMs);

  const [{ used }] = await db.execute<{ used: string }>(sql`
    SELECT COALESCE(SUM(${creditUsageLog.credits}), 0) AS used
    FROM ${creditUsageLog}
    WHERE ${creditUsageLog.userId} = ${userId}
      AND ${creditUsageLog.status} = 'success'
      AND ${creditUsageLog.createdAt} >= ${windowStart.toISOString()}
  `);

  const usedNum = Number(used);

  return {
    allowed: usedNum < creditLimit,
    used: usedNum,
    limit: creditLimit,
    windowHours,
    resetAt,
    roleName,
  };
}
