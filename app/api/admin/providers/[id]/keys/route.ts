import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { provider } from "@/lib/provider/schema";
import { encryptApiKey, stripProviderSecrets } from "@/lib/provider/admin";
import { invalidateModelCache } from "@/lib/provider/model-registry";
import { withAuth } from "@/lib/auth/with-auth";

type IdParams = { id: string };

const AddKeyBody = z.object({
  plaintext: z.string().min(1).max(2048),
});

const DeleteKeyBody = z.object({
  name: z.string().min(1).max(64),
});

async function loadProvider(id: string) {
  const [row] = await db.select().from(provider).where(eq(provider.id, id));
  return row;
}

export const POST = withAuth<IdParams>({ role: "admin" }, async (req, { params }) => {
  const existing = await loadProvider(params.id);
  if (!existing) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });

  const json = await req.json().catch(() => ({}));
  const parsed = AddKeyBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ code: "BAD_REQUEST", error: parsed.error.issues }, { status: 400 });
  }

  const next = encryptApiKey(parsed.data.plaintext);
  // ponytail: collide on the derived `name` rather than full plaintext
  // equality — the admin UI shows `name` and rotation uses `name` as the
  // identity, so matching by it keeps the UX consistent without leaking.
  const dup = existing.apiKeys.some((k) => k.name === next.name);
  if (dup) {
    return NextResponse.json(
      { code: "DUPLICATE_KEY", message: "a key with this tail already exists" },
      { status: 409 },
    );
  }

  const [row] = await db
    .update(provider)
    .set({
      apiKeys: [...existing.apiKeys, next],
      updatedAt: new Date(),
    })
    .where(eq(provider.id, params.id))
    .returning();
  invalidateModelCache();
  return NextResponse.json(stripProviderSecrets(row!), { status: 201 });
});

export const DELETE = withAuth<IdParams>({ role: "admin" }, async (req, { params }) => {
  const existing = await loadProvider(params.id);
  if (!existing) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });

  const json = await req.json().catch(() => ({}));
  const parsed = DeleteKeyBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ code: "BAD_REQUEST", error: parsed.error.issues }, { status: 400 });
  }

  const filtered = existing.apiKeys.filter((k) => k.name !== parsed.data.name);
  if (filtered.length === existing.apiKeys.length) {
    return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  }
  const [row] = await db
    .update(provider)
    .set({ apiKeys: filtered, updatedAt: new Date() })
    .where(eq(provider.id, params.id))
    .returning();
  invalidateModelCache();
  return NextResponse.json(stripProviderSecrets(row!));
});