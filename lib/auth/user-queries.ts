import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { role, user } from "@/lib/auth/schema";
import { creditUsageLog } from "@/lib/credit/schema";

export type AdminUserItem = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  emailVerified: boolean;
  roleId: string;
  roleName: string | null;
  banned: boolean;
  createdAt: Date;
  updatedAt: Date;
  todayCredits: number;
  todayInputTokens: number;
  todayOutputTokens: number;
  todayTokens: number;
  totalCredits: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
};

export async function getAdminUsersList(): Promise<AdminUserItem[]> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [userRows, usageRows] = await Promise.all([
    db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        emailVerified: user.emailVerified,
        roleId: user.roleId,
        roleName: role.name,
        banned: user.banned,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      })
      .from(user)
      .leftJoin(role, eq(user.roleId, role.id))
      .orderBy(asc(user.createdAt)),
    db
      .select({
        userId: creditUsageLog.userId,
        todayCredits: sql<string>`COALESCE(SUM(CASE WHEN ${creditUsageLog.createdAt} >= ${startOfToday.toISOString()} THEN ${creditUsageLog.credits} ELSE 0 END), 0)`,
        todayInputTokens: sql<number>`COALESCE(SUM(CASE WHEN ${creditUsageLog.createdAt} >= ${startOfToday.toISOString()} THEN ${creditUsageLog.inputTokens} ELSE 0 END), 0)`,
        todayOutputTokens: sql<number>`COALESCE(SUM(CASE WHEN ${creditUsageLog.createdAt} >= ${startOfToday.toISOString()} THEN ${creditUsageLog.outputTokens} ELSE 0 END), 0)`,
        totalCredits: sql<string>`COALESCE(SUM(${creditUsageLog.credits}), 0)`,
        totalInputTokens: sql<number>`COALESCE(SUM(${creditUsageLog.inputTokens}), 0)`,
        totalOutputTokens: sql<number>`COALESCE(SUM(${creditUsageLog.outputTokens}), 0)`,
      })
      .from(creditUsageLog)
      .where(eq(creditUsageLog.status, "success"))
      .groupBy(creditUsageLog.userId),
  ]);

  const usageMap = new Map(
    usageRows.map((u) => {
      const todayIn = Number(u.todayInputTokens) || 0;
      const todayOut = Number(u.todayOutputTokens) || 0;
      const totalIn = Number(u.totalInputTokens) || 0;
      const totalOut = Number(u.totalOutputTokens) || 0;
      return [
        u.userId,
        {
          todayCredits: Number(u.todayCredits) || 0,
          todayInputTokens: todayIn,
          todayOutputTokens: todayOut,
          todayTokens: todayIn + todayOut,
          totalCredits: Number(u.totalCredits) || 0,
          totalInputTokens: totalIn,
          totalOutputTokens: totalOut,
          totalTokens: totalIn + totalOut,
        },
      ];
    }),
  );

  return userRows.map((u) => {
    const usage = usageMap.get(u.id) ?? {
      todayCredits: 0,
      todayInputTokens: 0,
      todayOutputTokens: 0,
      todayTokens: 0,
      totalCredits: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
    };
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      image: u.image ?? null,
      emailVerified: u.emailVerified,
      roleId: u.roleId,
      roleName: u.roleName ?? null,
      banned: u.banned,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
      todayCredits: usage.todayCredits,
      todayInputTokens: usage.todayInputTokens,
      todayOutputTokens: usage.todayOutputTokens,
      todayTokens: usage.todayTokens,
      totalCredits: usage.totalCredits,
      totalInputTokens: usage.totalInputTokens,
      totalOutputTokens: usage.totalOutputTokens,
      totalTokens: usage.totalTokens,
    };
  });
}
