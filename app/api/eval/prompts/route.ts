import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withAuth } from "@/lib/auth/with-auth";
import { promptTemplate, promptVariant } from "@/lib/eval/schema";
import { generateId } from "@/lib/ids/nanoid";

export const runtime = "nodejs";

export const GET = withAuth(async () => {
  try {
    const templates = await db.select().from(promptTemplate);
    const variants = await db.select().from(promptVariant);
    return NextResponse.json({ templates, variants });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});

export const POST = withAuth(async (req, { user }) => {
  try {
    const body = (await req.json()) as {
      action?:
        | "create_template"
        | "create_cohort_variant"
        | "create_variant"
        | "update_variant_weight"
        | "batch_update_weights";
      agent?: string;
      content?: string;
      notes?: string;
      templateId?: string;
      variantId?: string;
      label?: string;
      trafficWeight?: number;
      enabled?: boolean;
      updates?: Array<{ variantId: string; trafficWeight: number; enabled?: boolean }>;
    };

    if (body.action === "create_template") {
      if (!body.agent || !body.content) {
        return NextResponse.json({ error: "agent and content are required" }, { status: 400 });
      }
      const GRAPH_MAPPING: Record<string, string> = {
        chatAgent: "agent",
        routerAgent: "agent",
        weatherAgent: "agent",
        cryptoAgent: "agent",
        codeAgent: "agent",
        renameThreadAgent: "background_agent",
        threadSummarizeAgent: "background_agent",
        kbOcrAgent: "kbAgent",
        kbEntityExtractAgent: "kbAgent",
        kbEntityAlignAgent: "kbAgent",
      };
      const groupName = body.notes?.startsWith("Group:")
        ? (body.notes.split(":")[1]?.trim() ?? "agent")
        : (GRAPH_MAPPING[body.agent] ?? "agent");

      const id = `tmpl_${generateId()}`;
      const created = await db
        .insert(promptTemplate)
        .values({
          id,
          group: groupName,
          agent: body.agent,
          content: body.content,
          notes: body.notes ?? null,
          userId: user.id,
        })
        .returning();
      return NextResponse.json({ template: created[0] });
    }

    if (body.action === "create_cohort_variant") {
      const cohortBody = body as unknown as {
        label: string;
        trafficWeight: number;
        bindings: Record<string, string>;
      };

      if (!cohortBody.label || typeof cohortBody.trafficWeight !== "number") {
        return NextResponse.json(
          { error: "label and trafficWeight are required" },
          { status: 400 },
        );
      }

      const bindings = cohortBody.bindings || {};
      const createdVariants = [];

      for (const [agent, tmplId] of Object.entries(bindings)) {
        if (!tmplId) continue;
        const id = `var_${generateId()}`;
        const [created] = await db
          .insert(promptVariant)
          .values({
            id,
            templateId: tmplId,
            label: cohortBody.label.trim(),
            trafficWeight: cohortBody.trafficWeight,
            enabled: true,
          })
          .returning();
        createdVariants.push(created);
      }

      return NextResponse.json({ variants: createdVariants });
    }

    if (body.action === "create_variant") {
      if (!body.templateId || !body.label || typeof body.trafficWeight !== "number") {
        return NextResponse.json(
          { error: "templateId, label, and trafficWeight are required" },
          { status: 400 },
        );
      }
      const id = `var_${generateId()}`;
      const created = await db
        .insert(promptVariant)
        .values({
          id,
          templateId: body.templateId,
          label: body.label,
          trafficWeight: body.trafficWeight,
          enabled: body.enabled ?? true,
        })
        .returning();
      return NextResponse.json({ variant: created[0] });
    }

    if (body.action === "update_variant_weight") {
      if (!body.variantId || typeof body.trafficWeight !== "number") {
        return NextResponse.json(
          { error: "variantId and trafficWeight are required" },
          { status: 400 },
        );
      }
      const updated = await db
        .update(promptVariant)
        .set({
          trafficWeight: body.trafficWeight,
          enabled: body.enabled !== undefined ? body.enabled : true,
          updatedAt: new Date(),
        })
        .where(eq(promptVariant.id, body.variantId))
        .returning();
      return NextResponse.json({ variant: updated[0] });
    }

    if (body.action === "batch_update_weights") {
      if (!Array.isArray(body.updates)) {
        return NextResponse.json({ error: "updates array is required" }, { status: 400 });
      }
      for (const update of body.updates) {
        if (update.variantId && typeof update.trafficWeight === "number") {
          await db
            .update(promptVariant)
            .set({
              trafficWeight: update.trafficWeight,
              enabled: update.enabled !== undefined ? update.enabled : true,
              updatedAt: new Date(),
            })
            .where(eq(promptVariant.id, update.variantId));
        }
      }
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});

export const PUT = withAuth(async (req) => {
  try {
    const body = (await req.json()) as { id?: string; content?: string; notes?: string };
    if (!body.id) {
      return NextResponse.json({ error: "Template id is required" }, { status: 400 });
    }
    const [updated] = await db
      .update(promptTemplate)
      .set({
        ...(body.content !== undefined ? { content: body.content } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        updatedAt: new Date(),
      })
      .where(eq(promptTemplate.id, body.id))
      .returning();
    return NextResponse.json({ template: updated });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});

export const DELETE = withAuth(async (req) => {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id parameter is required" }, { status: 400 });
    }

    const [tmpl] = await db.select().from(promptTemplate).where(eq(promptTemplate.id, id));
    if (!tmpl) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    if (!tmpl.userId) {
      return NextResponse.json({ error: "System templates cannot be deleted" }, { status: 403 });
    }

    await db.delete(promptTemplate).where(eq(promptTemplate.id, id));
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
