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

// ponytail: calendar-aligned rolling window in **UTC**. Windows are
// fixed N-hour buckets starting at UTC 00:00 — for windowHours=8 the
// boundaries are 00:00 / 08:00 / 16:00, for windowHours=24 it's just
// 00:00. The SQL predicate `created_at >= windowStart` and the
// displayed resetAt (`windowStart + windowHours`) are computed from
// the same JS-side windowStart so they can't drift. Reset times
// display in the user's local timezone via `toLocaleTimeString` in
// the progress components.
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

  // UTC-aligned window floor: bucket Date.now() into a multiple of
  // windowHours from the Unix epoch. epoch=0 falls on a UTC midnight
  // boundary, so the floors land on 00:00 / 08:00 / 16:00 UTC for
  // windowHours=8.
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
