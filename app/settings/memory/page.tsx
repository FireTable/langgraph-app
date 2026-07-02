import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { MemoryView } from "@/components/settings/memory-view";
import { auth } from "@/lib/auth/config";

// ponytail: server component gates the memory view — better-auth's
// client `useSession` would 404-fetch on first paint, which is the
// flicker we're avoiding. Unauthenticated visitors get bounced to the
// sign-in path (configured in app/auth-shell.tsx).
export default async function MemorySettingsPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");

  return <MemoryView />;
}
