import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { role, user } from "@/lib/auth/schema";
import { creditUsageLog } from "./schema";

export type QuotaStatus = {
  allowed: boolean;
  used: number;
  limit: number; // Number.POSITIVE_INFINITY for unlimited
  resetAt: Date;
};

// Sum credits used in the rolling window AND find the oldest in-window
// call (used to compute resetAt = "when does the oldest call age out").
// Single round-trip — both queries are indexed by (user_id, created_at).
//
// Admin role: creditLimit IS NULL → unlimited, skip the SUM entirely.
export async function checkQuota(userId: string): Promise<QuotaStatus> {
  const [{ creditLimit, windowHours }] = await db
    .select({
      creditLimit: role.creditLimit,
      windowHours: role.windowHours,
    })
    .from(user)
    .innerJoin(role, eq(user.roleId, role.id))
    .where(eq(user.id, userId));

  if (creditLimit === null) {
    return {
      allowed: true,
      used: 0,
      limit: Number.POSITIVE_INFINITY,
      resetAt: new Date(),
    };
  }

  const windowStart = new Date(Date.now() - windowHours * 3600 * 1000);
  const windowStartIso = windowStart.toISOString();
  const [{ used, oldestInWindow }] = await db.execute<{
    used: string;
    oldestInWindow: Date | null;
  }>(sql`
    SELECT
      COALESCE(SUM(${creditUsageLog.credits}), 0) AS used,
      MIN(${creditUsageLog.createdAt}) AS "oldestInWindow"
    FROM ${creditUsageLog}
    WHERE ${creditUsageLog.userId} = ${userId}
      AND ${creditUsageLog.status} = 'success'
      AND ${creditUsageLog.createdAt} >= ${windowStartIso}::timestamp
  `);

  const usedNum = Number(used);
  const resetAt = oldestInWindow
    ? new Date(new Date(oldestInWindow).getTime() + windowHours * 3600 * 1000)
    : new Date();

  return {
    allowed: usedNum < creditLimit,
    used: usedNum,
    limit: creditLimit,
    resetAt,
  };
}
