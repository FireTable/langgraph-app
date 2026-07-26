import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/config";
import { BrandMarkLink } from "@/components/brand-mark";
import { EvalDashboardClient } from "@/app/admin/eval/eval-dashboard-client";
import { ObservabilitySheetProvider } from "@/components/observability/sheet-context";
import { ObservabilitySheet } from "@/components/observability/sheet";

export default async function EvalAdminPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  if (session.user.roleId !== "admin") redirect("/");

  return (
    <ObservabilitySheetProvider>
      <div className="mt-2 flex h-12 shrink-0 items-center gap-2 px-4 md:px-6">
        <BrandMarkLink />
        <span className="text-muted-foreground text-sm">Admin / Eval & A/B Testing</span>
      </div>
      <div className="mx-auto w-full px-4 md:px-6 pb-8 pt-4 md:pb-12 md:pt-8">
        <h1 className="mb-2 text-2xl font-semibold tracking-tight">
          Agent Evaluation & A/B Platform
        </h1>
        <p className="text-muted-foreground mb-6 text-sm">
          Manage System Prompts, control A/B traffic split weights, and analyze side-by-side model
          performance metrics.
        </p>
        <EvalDashboardClient />
      </div>
      <ObservabilitySheet />
    </ObservabilitySheetProvider>
  );
}
