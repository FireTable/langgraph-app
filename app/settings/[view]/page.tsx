import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { Settings } from "@/components/auth/settings/settings";
import { BrandMarkLink } from "@/components/brand-mark";
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
  // ponytail: outer container caps width and centers — without it the
  // shadcn <Settings> tabs + cards stretch edge-to-edge on wide
  // viewports and look "naked". max-w-3xl matches the rest of the app
  // (see thread.tsx message max-width). The BrandMarkLink lives in a
  // separate top row at the viewport's left edge so its x-position
  // matches the chat sidebar's brand (px-6 from the left) — the only
  // way out of a settings page that has no sidebar of its own.
  return (
    <>
      <div className="mt-2 flex h-12 shrink-0 items-center px-4 md:px-6">
        <BrandMarkLink />
      </div>
      <div className="mx-auto w-full px-4 md:px-6 pb-8 pt-4 md:pb-12 md:pt-8">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight">Settings</h1>
        <Settings path={view} />
      </div>
    </>
  );
}
