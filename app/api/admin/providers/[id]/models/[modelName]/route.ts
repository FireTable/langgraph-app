import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { provider } from "@/lib/provider/schema";
import { stripProviderSecrets } from "@/lib/provider/admin";
import { invalidateModelCache } from "@/lib/provider/model-registry";
import { withAuth } from "@/lib/auth/with-auth";

type ModelParams = { id: string; modelName: string };

// ponytail: the input side requires enabled / inputPer1k / outputPer1k, so
// a partial PATCH has to lift those out of `.partial()` and re-require them
// individually — otherwise a PATCH with `{}` would no-op and the caller has
// no signal that "no fields were sent".
const ModelPatchBody = z.object({
  name: z.string().min(1).max(128).optional(),
  enabled: z.boolean().optional(),
  inputPer1k: z.number().min(0).optional(),
  outputPer1k: z.number().min(0).optional(),
});

export const PATCH = withAuth<ModelParams>({ role: "admin" }, async (req, { params }) => {
  const [existing] = await db.select().from(provider).where(eq(provider.id, params.id));
  if (!existing) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });

  const json = await req.json().catch(() => ({}));
  const parsed = ModelPatchBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ code: "BAD_REQUEST", error: parsed.error.issues }, { status: 400 });
  }
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ code: "BAD_REQUEST", error: "empty patch" }, { status: 400 });
  }

  const idx = existing.models.findIndex((m) => m.name === params.modelName);
  if (idx === -1) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });

  // ponytail: name is the array key — a rename has to swap the entry in
  // place. Collision check excludes self so "rename to same name" is a
  // safe no-op for the caller that round-trips the dialog's current value.
  const nextName = parsed.data.name?.trim() ?? existing.models[idx].name;
  if (nextName !== existing.models[idx].name) {
    const collides = existing.models.some((m, i) => i !== idx && m.name === nextName);
    if (collides) return NextResponse.json({ code: "DUPLICATE_MODEL" }, { status: 409 });
  }

  const nextModels = [...existing.models];
  nextModels[idx] = {
    ...nextModels[idx],
    ...parsed.data,
    name: nextName,
  };

  const [row] = await db
    .update(provider)
    .set({ models: nextModels, updatedAt: new Date() })
    .where(eq(provider.id, params.id))
    .returning();
  invalidateModelCache();
  return NextResponse.json(stripProviderSecrets(row!));
});

export const DELETE = withAuth<ModelParams>({ role: "admin" }, async (_req, { params }) => {
  const [existing] = await db.select().from(provider).where(eq(provider.id, params.id));
  if (!existing) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });

  const next = existing.models.filter((m) => m.name !== params.modelName);
  if (next.length === existing.models.length) {
    return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  }
  await db
    .update(provider)
    .set({ models: next, updatedAt: new Date() })
    .where(eq(provider.id, params.id));
  invalidateModelCache();
  return new NextResponse(null, { status: 204 });
});
