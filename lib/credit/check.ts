import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { role, user } from "@/lib/auth/schema";
import { creditUsageLog } from "./schema";

export type QuotaStatus = {
  allowed: boolean;
  used: number;
  limit: number; // Number.POSITIVE_INFINITY for unlimited
  windowHours: number; // 0 when unlimited (admin role)
  resetAt: Date;
  roleName: string;
};

// ponytail: the quota window is a fixed calendar day in **server
// time (UTC)**, not a rolling 24h-from-first-call window. Every user
// sees the same resetAt (next UTC 00:00), which makes "resets at
// 14:06" stop drifting per-user depending on when they happened to
// place their first in-window call. windowHours stays on the role
// row for now but is treated as the count of hours the window stays
// open (24 = a full UTC day; smaller values could mean shorter
// multi-reset windows — see the TODO in the SQL).
//
// Admin role: creditLimit IS NULL → unlimited, skip the SUM entirely.
export async function checkQuota(userId: string): Promise<QuotaStatus> {
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

  // Fixed calendar window in UTC. We pick the start of the current
  // UTC day as the window floor; resetAt is start-of-next-UTC-day.
  // SUM is bounded by the same predicate so `used` never sees
  // out-of-window rows.
  //
  // Note: windowHours is read but currently unused on the SQL side
  // — the schema supports sub-day windows but only the 24h case is
  // wired in. To honor a shorter windowHours, replace
  // `date_trunc('day', now() AT TIME ZONE 'UTC')` with
  // `now() - (windowHours || ' hours')::interval` and compute
  // resetAt in JS. Out of scope for this MVP — keeping the window
  // floor on a UTC day boundary matches the chat-surface copy.
  const [{ used }] = await db.execute<{ used: string }>(sql`
    SELECT COALESCE(SUM(${creditUsageLog.credits}), 0) AS used
    FROM ${creditUsageLog}
    WHERE ${creditUsageLog.userId} = ${userId}
      AND ${creditUsageLog.status} = 'success'
      AND ${creditUsageLog.createdAt} >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
  `);

  const usedNum = Number(used);

  return {
    allowed: usedNum < creditLimit,
    used: usedNum,
    limit: creditLimit,
    windowHours,
    resetAt: nextUtcMidnight(),
    roleName,
  };
}

// ponytail: independent of DB — keeps the SQL path to one round-trip
// and lets the proxy / UserButton display a stable "resets at HH:MM"
// even when the user has spent nothing in the current window.
function nextUtcMidnight(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
}
