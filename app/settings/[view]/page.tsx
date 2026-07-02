import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { Settings } from "@/components/auth/settings/settings";
import { auth } from "@/lib/auth/config";

// ponytail: catch-all routes /settings/account, /settings/security, and
// /settings/memory through one component. <Settings path={view}> resolves
// the active tab via useAuth() — better-auth-ui's UserButton links to
// `/settings/account` (default viewPaths.settings.account), so this
// single dynamic segment covers both the built-in tabs and the Memory
// tab contributed by memory-tab.tsx without three near-identical files.
export default async function SettingsPage({ params }: { params: Promise<{ view: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");

  const { view } = await params;
  return <Settings path={view} />;
}
