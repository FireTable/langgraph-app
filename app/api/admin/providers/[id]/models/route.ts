import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { provider } from "@/lib/provider/schema";
import { modelConfigSchema } from "@/lib/credit/zod";
import { stripProviderSecrets } from "@/lib/provider/admin";
import { invalidateModelCache } from "@/lib/provider/model-registry";
import { withAuth } from "@/lib/auth/with-auth";

type IdParams = { id: string };

export const POST = withAuth<IdParams>({ role: "admin" }, async (req, { params }) => {
  const [existing] = await db.select().from(provider).where(eq(provider.id, params.id));
  if (!existing) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });

  const json = await req.json().catch(() => ({}));
  const parsed = modelConfigSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ code: "BAD_REQUEST", error: parsed.error.issues }, { status: 400 });
  }
  if (existing.models.some((m) => m.name === parsed.data.name)) {
    return NextResponse.json(
      { code: "DUPLICATE_MODEL", message: "a model with this name already exists" },
      { status: 409 },
    );
  }

  const [row] = await db
    .update(provider)
    .set({ models: [...existing.models, parsed.data], updatedAt: new Date() })
    .where(eq(provider.id, params.id))
    .returning();
  invalidateModelCache();
  return NextResponse.json(stripProviderSecrets(row!), { status: 201 });
});
