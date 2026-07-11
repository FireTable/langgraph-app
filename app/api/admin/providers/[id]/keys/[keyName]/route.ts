import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { provider } from "@/lib/provider/schema";
import { encryptApiKey, stripProviderSecrets } from "@/lib/provider/admin";
import { withAuth } from "@/lib/auth/with-auth";

type KeyParams = { id: string; keyName: string };

const RotateBody = z.object({
  plaintext: z.string().min(1).max(2048),
});

export const PATCH = withAuth<KeyParams>({ role: "admin" }, async (req, { params }) => {
  const [existing] = await db.select().from(provider).where(eq(provider.id, params.id));
  if (!existing) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });

  const json = await req.json().catch(() => ({}));
  const parsed = RotateBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ code: "BAD_REQUEST", error: parsed.error.issues }, { status: 400 });
  }

  const idx = existing.apiKeys.findIndex((k) => k.name === params.keyName);
  if (idx === -1) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });

  // ponytail: keep the original `name` (the UI identifier) — rotate
  // re-encrypts the blob + iv, the derived tail stays the same so existing
  // links into the admin UI keep working.
  const rotated = encryptApiKey(parsed.data.plaintext);
  const nextKeys = [...existing.apiKeys];
  nextKeys[idx] = { ...nextKeys[idx], encryptedKey: rotated.encryptedKey, iv: rotated.iv };

  const [row] = await db
    .update(provider)
    .set({ apiKeys: nextKeys, updatedAt: new Date() })
    .where(eq(provider.id, params.id))
    .returning();
  return NextResponse.json(stripProviderSecrets(row!));
});
