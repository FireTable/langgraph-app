import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { provider } from "@/lib/provider/schema";
import { providerInputSchema } from "@/lib/credit/zod";
import { stripProviderSecrets } from "@/lib/provider/admin";
import { invalidateModelCache } from "@/lib/provider/model-registry";
import { withAuth } from "@/lib/auth/with-auth";

export const GET = withAuth({ role: "admin" }, async () => {
  const rows = await db.select().from(provider).orderBy(provider.id);
  return NextResponse.json({ providers: rows.map(stripProviderSecrets) });
});

export const POST = withAuth({ role: "admin" }, async (req) => {
  const json = await req.json().catch(() => ({}));
  const parsed = providerInputSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ code: "BAD_REQUEST", error: parsed.error.issues }, { status: 400 });
  }
  // ponytail: the unique PK on provider.id trips first — surface as a
  // typed 409 instead of letting Drizzle throw through to a generic 500.
  // `onConflictDoNothing` keeps the SELECT-on-returning semantics so
  // we can detect "no row inserted" and map it to DUPLICATE.
  const [row] = await db
    .insert(provider)
    .values(parsed.data)
    .onConflictDoNothing({ target: provider.id })
    .returning();
  if (!row) {
    return NextResponse.json(
      { code: "DUPLICATE", message: `provider ${parsed.data.id} already exists` },
      { status: 409 },
    );
  }
  invalidateModelCache();
  return NextResponse.json(stripProviderSecrets(row), { status: 201 });
});
