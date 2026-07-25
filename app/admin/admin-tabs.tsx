"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProvidersPanel } from "@/app/admin/providers/providers-client";
import { RolesPanel } from "@/app/admin/roles/roles-client";
import { UsersPanel } from "@/app/admin/users/users-client";
import { EvalDashboardClient } from "@/app/admin/eval/eval-dashboard-client";
import type { PublicProviderRow, RoleRow, UserRow } from "@/app/admin/types";

export type { PublicProviderRow, RoleRow, UserRow };

export function AdminTabs({
  providers,
  roles,
  users,
}: {
  providers: PublicProviderRow[];
  roles: RoleRow[];
  users: UserRow[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const activeTab =
    tabParam && ["providers", "roles", "users", "eval"].includes(tabParam) ? tabParam : "providers";

  const handleTabChange = (val: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", val);
    router.replace(`/admin?${params.toString()}`, { scroll: false });
  };

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange}>
      <TabsList>
        <TabsTrigger value="providers">Providers</TabsTrigger>
        <TabsTrigger value="roles">Roles</TabsTrigger>
        <TabsTrigger value="users">Users</TabsTrigger>
        <TabsTrigger value="eval">Eval & A/B</TabsTrigger>
      </TabsList>
      <TabsContent value="providers">
        <ProvidersPanel initial={providers} />
      </TabsContent>
      <TabsContent value="roles">
        <RolesPanel initial={roles} />
      </TabsContent>
      <TabsContent value="users">
        <UsersPanel initial={users} roles={roles} />
      </TabsContent>
      <TabsContent value="eval">
        <div className="pt-2">
          <EvalDashboardClient />
        </div>
      </TabsContent>
    </Tabs>
  );
}
