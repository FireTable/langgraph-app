import { redirect } from "next/navigation";

import { getSessionFromHeaders } from "@/lib/auth/queries";

import { VerifiedView } from "./verified-view";

// Better Auth's email verification lands here via callbackURL=/login/verified
// (rewritten from the default "/" in lib/auth/config.ts). The token is
// consumed server-side by Better Auth and never forwarded in the 302, so
// `searchParams` has no verification signal we can trust — the only reliable
// signal is `session` (autoSignInAfterVerification is on, see
// lib/auth/config.ts). Anyone landing here without a session is a random
// visitor / bookmark, not a verified user, and gets redirected to /login.
export default async function VerifiedPage() {
  const session = await getSessionFromHeaders();

  if (!session) {
    redirect("/login");
  }

  return <VerifiedView hasSession />;
}
