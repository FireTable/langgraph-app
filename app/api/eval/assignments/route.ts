import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withAuth } from "@/lib/auth/with-auth";
import { promptVariantAssignment, promptVariant, promptTemplate } from "@/lib/eval/schema";
import { user } from "@/lib/auth/schema";

export const runtime = "nodejs";

export const GET = withAuth({ role: "admin" }, async () => {
  try {
    const assignments = await db
      .select({
        userId: promptVariantAssignment.userId,
        userName: user.name,
        userEmail: user.email,
        userImage: user.image,
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

export const POST = withAuth({ role: "admin" }, async (req) => {
  try {
    const body = (await req.json()) as {
      userId?: string;
      cohortLabel?: string;
      agent?: string;
      targetVariantId?: string;
    };

    if (!body.userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    if (body.cohortLabel) {
      // Find all variants matching cohortLabel
      const allVariants = await db
        .select({
          variantId: promptVariant.id,
          label: promptVariant.label,
          agent: promptTemplate.agent,
        })
        .from(promptVariant)
        .innerJoin(promptTemplate, eq(promptVariant.templateId, promptTemplate.id));

      const cohortVariants = allVariants.filter((v) => v.label === body.cohortLabel);
      const defaultVariants = allVariants.filter((v) => v.label === "default");

      const agentMap = new Map<string, string>();
      // First populate with default
      for (const v of defaultVariants) {
        agentMap.set(v.agent, v.variantId);
      }
      // Override with cohort variants if present
      for (const v of cohortVariants) {
        agentMap.set(v.agent, v.variantId);
      }

      for (const [agentName, variantId] of agentMap.entries()) {
        const existing = await db
          .select()
          .from(promptVariantAssignment)
          .where(
            and(
              eq(promptVariantAssignment.userId, body.userId),
              eq(promptVariantAssignment.agent, agentName),
            ),
          );

        if (existing.length > 0) {
          await db
            .update(promptVariantAssignment)
            .set({ variantId, assignedAt: new Date() })
            .where(
              and(
                eq(promptVariantAssignment.userId, body.userId),
                eq(promptVariantAssignment.agent, agentName),
              ),
            );
        } else {
          await db.insert(promptVariantAssignment).values({
            userId: body.userId,
            agent: agentName,
            variantId,
            assignedAt: new Date(),
          });
        }
      }

      return NextResponse.json({ success: true, updatedAgentsCount: agentMap.size });
    }

    if (!body.targetVariantId) {
      return NextResponse.json(
        { error: "cohortLabel or targetVariantId is required" },
        { status: 400 },
      );
    }

    const agentName = body.agent || "chatAgent";

    const existing = await db
      .select()
      .from(promptVariantAssignment)
      .where(
        and(
          eq(promptVariantAssignment.userId, body.userId),
          eq(promptVariantAssignment.agent, agentName),
        ),
      );

    if (existing.length > 0) {
      await db
        .update(promptVariantAssignment)
        .set({
          variantId: body.targetVariantId,
          assignedAt: new Date(),
        })
        .where(
          and(
            eq(promptVariantAssignment.userId, body.userId),
            eq(promptVariantAssignment.agent, agentName),
          ),
        );
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
