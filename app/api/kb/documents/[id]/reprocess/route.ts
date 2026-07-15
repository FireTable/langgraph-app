import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/with-auth";
import { fireIngestionRun } from "@/lib/kb/ingest";
import { getAttachmentForUser } from "@/lib/attachments/queries";
import {
  deleteKbChunksByDocumentId,
  findKbDocumentById,
  resetKbDocumentForReprocess,
  withKbTx,
} from "@/lib/kb/queries";

// ponytail: Settings → KB → per-row "Refresh" button. Re-runs OCR +
// chunk + embed against the existing attachment for a doc that's
// already in the DB. The Settings UI shows status via 2s polling, so
// we fire-and-forget the run and return 202.
//
// Status guards:
// - status='pending' / 'parsing' → 409 PROCESSING — a run is already
//   in flight, double-clicking the refresh button shouldn't kick off
//   a parallel pipeline against the same attachment.
// Cross-user docs → 404 (no existence leak, same convention as
// /api/threads).

type Params = { id: string };

export const POST = withAuth<Params>(async (_req, { user, params }) => {
  const doc = await findKbDocumentById(user.id, params.id);
  if (!doc) {
    return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  }
  if (doc.status === "pending" || doc.status === "parsing") {
    return NextResponse.json({ code: "PROCESSING" }, { status: 409 });
  }

  // ponytail: clear stale chunks + flip the doc row's status back to
  // "pending" inside one tx so the Settings UI sees a clean state if
  // the deletion succeeds but the dispatch step below fails.
  await withKbTx(async (tx) => {
    await deleteKbChunksByDocumentId(tx, doc.id);
    await resetKbDocumentForReprocess(user.id, doc.id);
  });

  if (!doc.attachmentId) {
    // ponytail: no attachment means no R2 file to re-OCR. The row
    // already shows pending — the user can re-upload or delete. Surface
    // the gap rather than swallowing it.
    return NextResponse.json({ code: "ATTACHMENT_MISSING" }, { status: 409 });
  }

  const attachment = await getAttachmentForUser(doc.attachmentId, user.id);
  if (!attachment) {
    return NextResponse.json({ code: "ATTACHMENT_MISSING" }, { status: 409 });
  }

  try {
    await fireIngestionRun({
      userId: user.id,
      attachment,
      docId: doc.id,
      title: doc.title,
      source: "kb-reprocess",
    });
  } catch (err) {
    // ponytail: row is back to pending + chunks are wiped. A failed
    // dispatch leaves the row in pending and the next Settings poll
    // (or another reprocess click) can retry — same UX as a fresh
    // upload that hit a transient network blip.
    console.error("POST /api/kb/documents/[id]/reprocess: fireIngestionRun failed", err);
  }

  return NextResponse.json({ docId: doc.id }, { status: 202 });
});
