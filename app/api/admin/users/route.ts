import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { role, user } from "@/lib/auth/schema";
import { withAuth } from "@/lib/auth/with-auth";

// ponytail: list every user with their role snapshot. We JOIN through
// `role` so the UI can show "Admin" / "User" labels without a second
// round-trip — the FK guarantees the join target exists. `banned` and
// `emailVerified` are included so the table renders a status badge
// without client-side joining.
export const GET = withAuth({ role: "admin" }, async () => {
  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      roleId: user.roleId,
      roleName: role.name,
      banned: user.banned,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    })
    .from(user)
    .leftJoin(role, eq(user.roleId, role.id))
    .orderBy(asc(user.createdAt));

  return NextResponse.json({ users: rows });
});
