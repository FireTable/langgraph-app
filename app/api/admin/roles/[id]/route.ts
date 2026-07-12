import { NextResponse } from "next/server";
import { count, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { role, user } from "@/lib/auth/schema";
import { rolePatchSchema } from "@/lib/credit/zod";
import { withAuth } from "@/lib/auth/with-auth";

type IdParams = { id: string };

export const PATCH = withAuth<IdParams>({ role: "admin" }, async (req, { params }) => {
  const [existing] = await db.select().from(role).where(eq(role.id, params.id));
  if (!existing) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });

  const json = await req.json().catch(() => ({}));
  const parsed = rolePatchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ code: "BAD_REQUEST", error: parsed.error.issues }, { status: 400 });
  }
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ code: "BAD_REQUEST", error: "empty patch" }, { status: 400 });
  }

  const [row] = await db
    .update(role)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(role.id, params.id))
    .returning();
  return NextResponse.json(row);
});

export const DELETE = withAuth<IdParams>({ role: "admin" }, async (_req, { params }) => {
  const [existing] = await db.select().from(role).where(eq(role.id, params.id));
  if (!existing) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });

  // ponytail: refuse to drop a role while any user still references it —
  // deleting would violate the FK and the user row would either cascade or
  // hang the DB. Surface a 409 so the admin can re-assign before retrying.
  const [{ c }] = await db.select({ c: count() }).from(user).where(eq(user.roleId, params.id));
  if (c > 0) {
    return NextResponse.json(
      { code: "ROLE_IN_USE", message: `role is referenced by ${c} user(s)` },
      { status: 409 },
    );
  }

  await db.delete(role).where(eq(role.id, params.id));
  return new NextResponse(null, { status: 204 });
});
