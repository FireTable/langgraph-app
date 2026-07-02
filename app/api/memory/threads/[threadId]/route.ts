import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/with-auth";
import { deleteThreadSummaries } from "@/lib/memory/queries";

type ThreadIdParams = { threadId: string };

// ponytail: FR-016 — collapse all summaries for a threadId in one store
// batch op; 404 only when there's nothing to delete (a benign no-op vs
// the legitimate "nothing to forget" UX the UI shows). rule #9 keeps
// the route scoped to the caller.
export const DELETE = withAuth<ThreadIdParams>(async (_req, { user, params }) => {
  const deletedCount = await deleteThreadSummaries(user.id, params.threadId);
  if (deletedCount === 0) {
    return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, deletedCount });
});
