import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth/config";

import { VerifiedView } from "./verified-view";

// Better Auth's email verification lands here via callbackURL=/login/verified
// (rewritten from the default "/" in lib/auth/config.ts). By the time the
// user hits this page, the token has already been consumed and (with
// autoSignInAfterVerification, which Better Auth defaults to true) a session
// is established. This page is purely a success UX — confirmation, 5s
// auto-redirect, manual link.
//
// If someone lands here directly (no token, no session — e.g. bookmark or
// refresh after session expiry), we redirect to /login immediately so they
// don't see a misleading "verified" message for an email they didn't verify.
type SearchParams = Promise<{ token?: string }>;

export default async function VerifiedPage({ searchParams }: { searchParams: SearchParams }) {
  const { token } = await searchParams;
  const session = await auth.api.getSession({ headers: await headers() });

  if (!token && !session) {
    redirect("/login");
  }

  return <VerifiedView hasSession={!!session} />;
}
