import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { provider } from "@/lib/provider/schema";
import { providerInputSchema } from "@/lib/credit/zod";
import { encryptApiKey, stripProviderSecrets } from "@/lib/provider/admin";
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
  const [row] = await db.insert(provider).values(parsed.data).returning();
  return NextResponse.json(stripProviderSecrets(row!), { status: 201 });
});
