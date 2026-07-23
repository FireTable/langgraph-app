import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { creditUsageLog } from "@/lib/credit/schema";

export type UserUsageSummary = {
  todayCredits: number;
  todayInputTokens: number;
  todayOutputTokens: number;
  todayTokens: number;
  totalCredits: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
};

export async function getUserUsageSummary(userId: string): Promise<UserUsageSummary> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [row] = await db
    .select({
      todayCredits: sql<string>`COALESCE(SUM(CASE WHEN ${creditUsageLog.createdAt} >= ${startOfToday.toISOString()} THEN ${creditUsageLog.credits} ELSE 0 END), 0)`,
      todayInputTokens: sql<number>`COALESCE(SUM(CASE WHEN ${creditUsageLog.createdAt} >= ${startOfToday.toISOString()} THEN ${creditUsageLog.inputTokens} ELSE 0 END), 0)`,
      todayOutputTokens: sql<number>`COALESCE(SUM(CASE WHEN ${creditUsageLog.createdAt} >= ${startOfToday.toISOString()} THEN ${creditUsageLog.outputTokens} ELSE 0 END), 0)`,
      totalCredits: sql<string>`COALESCE(SUM(${creditUsageLog.credits}), 0)`,
      totalInputTokens: sql<number>`COALESCE(SUM(${creditUsageLog.inputTokens}), 0)`,
      totalOutputTokens: sql<number>`COALESCE(SUM(${creditUsageLog.outputTokens}), 0)`,
    })
    .from(creditUsageLog)
    .where(and(eq(creditUsageLog.userId, userId), eq(creditUsageLog.status, "success")));

  const todayIn = Number(row?.todayInputTokens) || 0;
  const todayOut = Number(row?.todayOutputTokens) || 0;
  const totalIn = Number(row?.totalInputTokens) || 0;
  const totalOut = Number(row?.totalOutputTokens) || 0;

  return {
    todayCredits: Number(row?.todayCredits) || 0,
    todayInputTokens: todayIn,
    todayOutputTokens: todayOut,
    todayTokens: todayIn + todayOut,
    totalCredits: Number(row?.totalCredits) || 0,
    totalInputTokens: totalIn,
    totalOutputTokens: totalOut,
    totalTokens: totalIn + totalOut,
  };
}
