import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/with-auth";
import { db } from "@/db/client";
import { findKbDocumentById } from "@/lib/kb/queries";
import { kbObservability } from "@/lib/kb/schema";

// ponytail: Settings → KB → doc row → Activity icon → popover data
// source. Reads the kb_observability table directly (no SDK call) so
// the popover sees runs from BOTH ingest paths:
//   - standalone (Settings upload / reprocess): threadId = docId-派生
//   - chat (mainAgent → kbAgent subgraph):    threadId = chat thread
// Every kbAgent invocation inserts a row in prepareKBDataNode with
// (docId, threadId, parentMessageId, source, mode, created_at), so the
// popover's "View runs" list IS the union. Per-run LangGraph status
// (running/pending/success/error) used to come from runs.list; that
// info lives in observability_spans now, surfaced via the sheet.

type Params = { id: string };

export const GET = withAuth<Params>(async (_req, { user, params }) => {
  // ponytail: rule #9 — cross-user doc id is 404, not 401/403, so
  // callers can't enumerate which doc ids exist.
  const doc = await findKbDocumentById(user.id, params.id);
  if (!doc) {
    return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  }

  const rows = await db
    .select()
    .from(kbObservability)
    .where(eq(kbObservability.docId, doc.id))
    .orderBy(desc(kbObservability.createdAt))
    .limit(50);

  const runs = rows.map((r) => ({
    runId: r.runId,
    threadId: r.threadId,
    parentMessageId: r.parentMessageId,
    source: r.source,
    mode: r.mode,
    createdAt: r.createdAt.toISOString(),
  }));

  return NextResponse.json({
    doc_id: doc.id,
    runs,
  });
});
