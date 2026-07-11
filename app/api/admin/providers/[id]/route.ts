import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { provider } from "@/lib/provider/schema";
import { providerPatchSchema } from "@/lib/credit/zod";
import { stripProviderSecrets } from "@/lib/provider/admin";
import { withAuth } from "@/lib/auth/with-auth";

type IdParams = { id: string };

async function loadProvider(id: string) {
  const [row] = await db.select().from(provider).where(eq(provider.id, id));
  return row;
}

export const PATCH = withAuth<IdParams>({ role: "admin" }, async (req, { params }) => {
  const existing = await loadProvider(params.id);
  if (!existing) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });

  const json = await req.json().catch(() => ({}));
  const parsed = providerPatchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ code: "BAD_REQUEST", error: parsed.error.issues }, { status: 400 });
  }
  const data = parsed.data;
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ code: "BAD_REQUEST", error: "empty patch" }, { status: 400 });
  }

  // ponytail: apiKeys / models are whole-array replacements when present —
  // callers should PUT the entire list rather than diff. That keeps the
  // surface small (no merge semantics) and matches how the admin UI
  // assembles rows.
  const [row] = await db
    .update(provider)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(provider.id, params.id))
    .returning();
  return NextResponse.json(stripProviderSecrets(row!));
});

export const DELETE = withAuth<IdParams>({ role: "admin" }, async (_req, { params }) => {
  const existing = await loadProvider(params.id);
  if (!existing) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  await db.delete(provider).where(eq(provider.id, params.id));
  return new NextResponse(null, { status: 204 });
});
