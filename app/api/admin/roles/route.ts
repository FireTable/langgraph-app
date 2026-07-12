import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { role } from "@/lib/auth/schema";
import { roleInputSchema } from "@/lib/credit/zod";
import { withAuth } from "@/lib/auth/with-auth";

export const GET = withAuth({ role: "admin" }, async () => {
  const rows = await db.select().from(role).orderBy(role.id);
  return NextResponse.json({ roles: rows });
});

export const POST = withAuth({ role: "admin" }, async (req) => {
  const json = await req.json().catch(() => ({}));
  const parsed = roleInputSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ code: "BAD_REQUEST", error: parsed.error.issues }, { status: 400 });
  }
  const [row] = await db.insert(role).values(parsed.data).returning();
  return NextResponse.json(row, { status: 201 });
});
