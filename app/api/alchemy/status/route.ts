import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/with-auth";

// ponytail: just reports whether ALCHEMY_API_KEY is set — never the
// value. The frontend uses this for the "🔑 configured / ⚠ not set"
// status badge on the Alchemy admin page.
//
// Auth: gated behind a Better Auth session check via withAuth. The
// /status endpoint tells the browser whether a key is set; previously
// any anonymous visitor could enumerate it. We deliberately do NOT
// expose the key value, so the only thing an authenticated user can
// learn is `{ configured: true | false }` — useful for the admin badge,
// useless for an attacker.
//
// Runtime: nodejs (not edge) so withAuth can hit Postgres through
// drizzle/postgres-js to read the session row.
export const GET = withAuth(() => {
  const key = process.env.ALCHEMY_API_KEY;
  return NextResponse.json({ configured: Boolean(key && key.length > 0) });
});
