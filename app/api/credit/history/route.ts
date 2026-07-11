import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { withAuth } from "@/lib/auth/with-auth";
import { db } from "@/db/client";
import { creditUsageLog } from "@/lib/credit/schema";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// ponytail: rule #9 — withAuth wraps every handler. No role gate —
// any signed-in user reads their OWN history. Cross-user isolation
// is enforced by the eq(userId, session.user.id) predicate; without
// that WHERE, the count and rows would leak other users' call logs.
export const GET = withAuth(async (req, { user }) => {
  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    limit: url.searchParams.get("limit") ?? undefined,
    offset: url.searchParams.get("offset") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ code: "BAD_REQUEST", error: parsed.error.issues }, { status: 400 });
  }
  const { limit, offset } = parsed.data;

  const where = eq(creditUsageLog.userId, user.id);

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: creditUsageLog.id,
        providerId: creditUsageLog.providerId,
        modelName: creditUsageLog.modelName,
        agentName: creditUsageLog.agentName,
        inputTokens: creditUsageLog.inputTokens,
        outputTokens: creditUsageLog.outputTokens,
        credits: creditUsageLog.credits,
        status: creditUsageLog.status,
        errorMessage: creditUsageLog.errorMessage,
        createdAt: creditUsageLog.createdAt,
      })
      .from(creditUsageLog)
      .where(where)
      .orderBy(desc(creditUsageLog.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(creditUsageLog)
      .where(where),
  ]);

  return NextResponse.json({
    calls: rows.map((row) => ({
      id: row.id,
      providerId: row.providerId,
      modelName: row.modelName,
      agentName: row.agentName,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      credits: Number(row.credits),
      status: row.status,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt.toISOString(),
    })),
    total,
  });
});
