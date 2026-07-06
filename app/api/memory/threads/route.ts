import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/with-auth";
import { getAllUserSummaries } from "@/lib/memory/queries";
import type { SummaryEntry } from "@/lib/memory/validators";

// ponytail: rule #9 — withAuth wraps every handler. The handler groups
// the flat `[key, value]` list returned by the store layer into
// per-threadId buckets; each bucket is sorted by sequence desc, and the
// outer list by the most-recent createdAt desc. The UI reads both
// orderings as-is.
export const GET = withAuth(async (_req, { user }) => {
  try {
    const all = await getAllUserSummaries(user.id);
    const groups = new Map<string, SummaryEntry[]>();
    for (const item of all) {
      const list = groups.get(item.value.threadId) ?? [];
      list.push(item.value);
      groups.set(item.value.threadId, list);
    }
    const threads = [...groups.entries()]
      .map(([threadId, summaries]) => ({
        threadId,
        summaries: [...summaries].sort((a, b) => b.sequence - a.sequence),
      }))
      .sort((a, b) => {
        // ponytail: sort by newest `createdAt` of each thread's most recent
        // summary — the Memory tab's outer list is "threads I've touched
        // lately", same shape as before but the timestamp field renamed
        // (summaries are immutable once written, so createdAt == updatedAt).
        const aMax = a.summaries[0]?.createdAt ?? "";
        const bMax = b.summaries[0]?.createdAt ?? "";
        return bMax.localeCompare(aMax);
      });
    return NextResponse.json({ threads });
  } catch (err) {
    console.error("GET /api/memory/threads failed", err);
    return NextResponse.json({ code: "INTERNAL" }, { status: 500 });
  }
});
