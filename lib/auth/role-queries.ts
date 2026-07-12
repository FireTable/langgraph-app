import { eq } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { db } from "@/db/client";
import { role, user } from "@/lib/auth/schema";

export type RoleRow = InferSelectModel<typeof role>;

export type UserWithRole = {
  id: string;
  email: string;
  roleId: string;
  role: RoleRow;
};

/**
 * Fetch a user joined to their role row in one round-trip. Used by:
 *   - lib/credit/check.ts  (needs role.creditLimit + role.windowHours)
 *   - admin routes         (need full role to decide gating)
 *
 * If the user has somehow lost their FK (shouldn't happen — schema
 * defaults + FK constraint prevent it), `role` will be undefined and
 * the caller should treat the user as "no privileges" (i.e. fall
 * through the cap check with the default 'user' role).
 */
export async function getUserWithRole(userId: string): Promise<UserWithRole | null> {
  const [row] = await db
    .select({
      id: user.id,
      email: user.email,
      roleId: user.roleId,
      role,
    })
    .from(user)
    .leftJoin(role, eq(user.roleId, role.id))
    .where(eq(user.id, userId));

  if (!row) return null;
  if (!row.role) {
    // FK violation — extremely rare, but defensive: return a synthetic
    // 'user' role so the caller can still operate (and surface a 500
    // upstream via the missing FK rather than a confusing null deref).
    return {
      id: row.id,
      email: row.email,
      roleId: row.roleId,
      role: {
        id: row.roleId,
        name: "Unknown",
        creditLimit: 0,
        windowHours: 24,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };
  }
  return {
    id: row.id,
    email: row.email,
    roleId: row.roleId,
    role: row.role,
  };
}
