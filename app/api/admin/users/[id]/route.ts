import { NextResponse } from "next/server";
import { count, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { role, session, user } from "@/lib/auth/schema";
import { withAuth } from "@/lib/auth/with-auth";

type IdParams = { id: string };

const UserPatchBody = z.object({
  roleId: z.string().min(1).optional(),
  banned: z.boolean().optional(),
});

async function loadUser(id: string) {
  const [row] = await db.select().from(user).where(eq(user.id, id));
  return row;
}

export const PATCH = withAuth<IdParams>({ role: "admin" }, async (req, { params }) => {
  const existing = await loadUser(params.id);
  if (!existing) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });

  const json = await req.json().catch(() => ({}));
  const parsed = UserPatchBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ code: "BAD_REQUEST", error: parsed.error.issues }, { status: 400 });
  }
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ code: "BAD_REQUEST", error: "empty patch" }, { status: 400 });
  }

  // ponytail: last-admin guard. Mirrors the default-provider protection
  // — the system can't boot without a path to admin pages, so we refuse
  // to demote or ban the only remaining admin. Self-edit is allowed so
  // an admin can still change their own name / role as long as another
  // admin exists.
  if (existing.roleId === "admin" && (parsed.data.roleId !== "admin" || parsed.data.banned === true)) {
    const [{ c }] = await db
      .select({ c: count() })
      .from(user)
      .where(eq(user.roleId, "admin"));
    if (c <= 1) {
      return NextResponse.json(
        { code: "LAST_ADMIN", message: "at least one admin must remain" },
        { status: 409 },
      );
    }
  }

  if (parsed.data.roleId) {
    const [target] = await db.select().from(role).where(eq(role.id, parsed.data.roleId));
    if (!target) {
      return NextResponse.json({ code: "ROLE_NOT_FOUND" }, { status: 404 });
    }
  }

  const [row] = await db
    .update(user)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(user.id, params.id))
    .returning();

  // ponytail: ban flips → revoke every existing session for that user
  // so the ban takes effect immediately (next request hits no session
  // row → 401). Without this, a banned user keeps chatting for up to
  // the 7d session expiry. Unban does NOT need a counterpart — they
  // sign in fresh once they want back in.
  if (parsed.data.banned === true) {
    await db.delete(session).where(eq(session.userId, params.id));
  }

  return NextResponse.json(row);
});

export const DELETE = withAuth<IdParams>({ role: "admin" }, async (_req, { params }) => {
  const existing = await loadUser(params.id);
  if (!existing) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });

  // ponytail: same last-admin rule applies to delete. The FK from
  // session / account cascades on user delete, so the row goes alone.
  if (existing.roleId === "admin") {
    const [{ c }] = await db
      .select({ c: count() })
      .from(user)
      .where(eq(user.roleId, "admin"));
    if (c <= 1) {
      return NextResponse.json(
        { code: "LAST_ADMIN", message: "at least one admin must remain" },
        { status: 409 },
      );
    }
  }

  await db.delete(user).where(eq(user.id, params.id));
  return new NextResponse(null, { status: 204 });
});