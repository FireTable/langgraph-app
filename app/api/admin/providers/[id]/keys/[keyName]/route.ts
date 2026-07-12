import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { provider, type ProviderApiKey } from "@/lib/provider/schema";
import { encryptApiKey, stripProviderSecrets } from "@/lib/provider/admin";
import { invalidateModelCache } from "@/lib/provider/model-registry";
import { withAuth } from "@/lib/auth/with-auth";

type KeyParams = { id: string; keyName: string };

// ponytail: path is keyed on the **original** name so existing admin
// UI links keep working. PATCH body accepts an optional `name` (rename)
// and optional `plaintext` (rotate / overwrite). Either field can be
// sent independently — sending only `plaintext` is the legacy rotate
// flow. Rotate re-derives `name` from the new plaintext unless the
// caller sent an explicit `name`. Collision check excludes the entry
// being patched so a rotate-to-same-tail is a no-op rename (still a
// fresh ciphertext, just same display).
const KeyPatchBody = z.object({
  plaintext: z.string().min(1).max(2048).optional(),
  // ponytail: deriveKeyName produces "<first3>…<last4>" with the literal
  // U+2026 ELLIPSIS in the middle, so the regex must allow it for
  // collision paths to be testable. The `/u` flag is required — without
  // it, JS regex literal matches the lone surrogate half instead of
  // the full character.
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_\-…]+$/u, "name must be alphanumeric / dash / underscore / ellipsis")
    .optional(),
});

export const PATCH = withAuth<KeyParams>({ role: "admin" }, async (req, { params }) => {
  const [existing] = await db.select().from(provider).where(eq(provider.id, params.id));
  if (!existing) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });

  const json = await req.json().catch(() => ({}));
  const parsed = KeyPatchBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ code: "BAD_REQUEST", error: parsed.error.issues }, { status: 400 });
  }
  if (!parsed.data.plaintext && !parsed.data.name) {
    return NextResponse.json({ code: "BAD_REQUEST", error: "empty patch" }, { status: 400 });
  }

  const idx = existing.apiKeys.findIndex((k) => k.name === params.keyName);
  if (idx === -1) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });

  const old = existing.apiKeys[idx];
  let nextEntry: ProviderApiKey;
  if (parsed.data.plaintext) {
    // ponytail: encryptApiKey returns a complete ProviderApiKey —
    // { encryptedKey, iv, name }. Caller-provided `name` overrides
    // the derived tail. Collision check below excludes self so a
    // rotate-to-same-tail is a no-op rename with a fresh ciphertext.
    const encrypted = encryptApiKey(parsed.data.plaintext);
    nextEntry = { ...encrypted, name: parsed.data.name ?? encrypted.name };
  } else {
    nextEntry = { ...old, name: parsed.data.name! };
  }

  if (nextEntry.name !== old.name) {
    const collides = existing.apiKeys.some((k, i) => i !== idx && k.name === nextEntry.name);
    if (collides) return NextResponse.json({ code: "DUPLICATE" }, { status: 409 });
  }

  const nextKeys = [...existing.apiKeys];
  nextKeys[idx] = nextEntry;

  const [row] = await db
    .update(provider)
    .set({ apiKeys: nextKeys, updatedAt: new Date() })
    .where(eq(provider.id, params.id))
    .returning();
  invalidateModelCache();
  return NextResponse.json(stripProviderSecrets(row!));
});
