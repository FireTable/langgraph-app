import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withAuth } from "@/lib/auth/with-auth";
import { promptVariantAssignment, promptVariant, promptTemplate } from "@/lib/eval/schema";
import { user } from "@/lib/auth/schema";

export const runtime = "nodejs";

export const GET = withAuth(async () => {
  try {
    const assignments = await db
      .select({
        userId: promptVariantAssignment.userId,
        userName: user.name,
        userEmail: user.email,
        variantId: promptVariantAssignment.variantId,
        variantLabel: promptVariant.label,
        templateId: promptVariant.templateId,
        agent: promptVariantAssignment.agent,
        assignedAt: promptVariantAssignment.assignedAt,
      })
      .from(promptVariantAssignment)
      .leftJoin(user, eq(promptVariantAssignment.userId, user.id))
      .leftJoin(promptVariant, eq(promptVariantAssignment.variantId, promptVariant.id))
      .leftJoin(promptTemplate, eq(promptVariant.templateId, promptTemplate.id));

    return NextResponse.json({ assignments });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});

export const POST = withAuth(async (req) => {
  try {
    const body = (await req.json()) as {
      userId?: string;
      agent?: string;
      targetVariantId?: string;
    };

    if (!body.userId || !body.targetVariantId) {
      return NextResponse.json(
        { error: "userId and targetVariantId are required" },
        { status: 400 },
      );
    }

    const agentName = body.agent || "chatAgent";

    const existing = await db
      .select()
      .from(promptVariantAssignment)
      .where(eq(promptVariantAssignment.userId, body.userId));

    if (existing.length > 0) {
      await db
        .update(promptVariantAssignment)
        .set({
          variantId: body.targetVariantId,
          assignedAt: new Date(),
        })
        .where(eq(promptVariantAssignment.userId, body.userId));
    } else {
      await db.insert(promptVariantAssignment).values({
        userId: body.userId,
        agent: agentName,
        variantId: body.targetVariantId,
        assignedAt: new Date(),
      });
    }

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
