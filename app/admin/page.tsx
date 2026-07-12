import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { asc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { provider } from "@/lib/provider/schema";
import { role, user } from "@/lib/auth/schema";
import { auth } from "@/lib/auth/config";
import { BrandMarkLink } from "@/components/brand-mark";
import { AdminTabs } from "@/app/admin/admin-tabs";
import type { PublicProvider } from "@/lib/provider/admin";

export default async function AdminPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");

  // ponytail: role check mirrors lib/auth/with-auth.ts (zod-validated then
  // fallback to "user"). A non-admin lands on / with no flash of admin UI.
  if (session.user.roleId !== "admin") redirect("/");

  const [providerRows, roleRows, userRows] = await Promise.all([
    db.select().from(provider).orderBy(provider.id),
    db.select().from(role).orderBy(role.id),
    db
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
      .orderBy(asc(user.createdAt)),
  ]);

  const providers: PublicProvider[] = providerRows.map((row) => ({
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    baseUrl: row.baseUrl,
    apiKeys: row.apiKeys.map(({ name }) => ({ name })),
    models: row.models,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));

  return (
    <>
      <div className="mt-2 flex h-12 shrink-0 items-center gap-2 px-4 md:px-6">
        <BrandMarkLink />
        <span className="text-muted-foreground text-sm">Admin</span>
      </div>
      <div className="mx-auto w-full px-4 md:px-6 pb-8 pt-4 md:pb-12 md:pt-8">
        <h1 className="mb-2 text-2xl font-semibold tracking-tight">Administration</h1>
        <p className="text-muted-foreground mb-6 text-sm">
          Manage LLM providers, API keys, models, roles and users.
        </p>
        <AdminTabs
          providers={providers.map((p) => ({
            ...p,
            createdAt: p.createdAt.toISOString(),
            updatedAt: p.updatedAt.toISOString(),
          }))}
          roles={roleRows.map((r) => ({
            ...r,
            createdAt: r.createdAt.toISOString(),
            updatedAt: r.updatedAt.toISOString(),
          }))}
          users={userRows.map((u) => ({
            id: u.id,
            name: u.name,
            email: u.email,
            emailVerified: u.emailVerified,
            roleId: u.roleId,
            roleName: u.roleName,
            banned: u.banned,
            createdAt: u.createdAt.toISOString(),
            updatedAt: u.updatedAt.toISOString(),
          }))}
        />
      </div>
    </>
  );
}
