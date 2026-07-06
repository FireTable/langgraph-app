import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/with-auth";
import { getAuthInfo, getMemoryDoc, getRecentThreadSummaries } from "@/lib/memory/queries";

// ponytail: rule #9 — withAuth wraps every handler. The handler
// returns store and auth as separate fields so the frontend can
// run the same mergeMemory logic as the model sees in <memory>
// and classify each field as "summarized by AI" vs "from account"
// using store-keys membership. Returning a single merged doc would
// hide the source of each value, and returning {value, source}
// would break the model's flat-memory expectation (LLM would read
// `name` as an object instead of a string).
//
// We deliberately don't import loadMemory() here — that helper
// returns the merged view (used by the model), but the API needs
// the raw pair to preserve provenance.
export const GET = withAuth(async (_req, { user }) => {
  try {
    const [store, auth, threads] = await Promise.all([
      getMemoryDoc(user.id).catch(() => ({})),
      getAuthInfo(user.id).catch(() => ({
        name: null,
        email: null,
        image: null,
        socials: [] as Array<{ provider: string }>,
      })),
      getRecentThreadSummaries(user.id).catch(() => []),
    ]);
    return NextResponse.json({ store, auth, threads });
  } catch (err) {
    console.error("GET /api/memory/profile failed", err);
    return NextResponse.json({ code: "INTERNAL" }, { status: 500 });
  }
});
