import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/with-auth";
import { getProfileDoc, getSocialAccounts } from "@/lib/memory/queries";

// ponytail: rule #9 — withAuth wraps every handler. The profile + session
// + socialAccounts triple is the read-side counterpart to save_memory's
// writes; deleting a key through this UI is the only path to forgetting
// a fact (per FR-020, profile fields are read-only in the chat).
export const GET = withAuth(async (_req, { user }) => {
  try {
    const [profile, socialAccounts] = await Promise.all([
      getProfileDoc(user.id),
      getSocialAccounts(user.id),
    ]);
    return NextResponse.json({
      profile,
      session: {
        name: user.name ?? null,
        email: user.email ?? null,
        image: user.image ?? null,
      },
      socialAccounts,
    });
  } catch (err) {
    console.error("GET /api/memory/profile failed", err);
    return NextResponse.json({ code: "INTERNAL" }, { status: 500 });
  }
});
