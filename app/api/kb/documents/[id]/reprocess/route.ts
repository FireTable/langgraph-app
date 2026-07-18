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
// Two modes via `?chunksOnly=true|false` query string:
//   - default (full):        wipe doc row back to "pending" + clear
//                            chunks, dispatch kbAgent which re-runs
//                            PDF render + OCR + chunk + embed.
//   - chunksOnly=true:        only clear chunks, leave doc row at its
//                             terminal status (success/failed), dispatch
//                             kbAgent with `mode: "chunksOnly"` so OCR
//                             is skipped and pages[].markdown is reused.
//
// Status guards:
// - status='pending' / 'parsing' → 409 PROCESSING — a run is already
//   in flight, double-clicking the refresh button shouldn't kick off
//   a parallel pipeline against the same attachment.
// Cross-user docs → 404 (no existence leak, same convention as
// /api/threads).
//
// ponytail: chunksOnly doc-status guard is stricter — we need a
// doc whose OCR already landed (status='success' or 'failed' with
// pages[].markdown populated). 409 NOT_READY surfaces the gap so
// the client can fall back to the default "Refresh" (full
// reprocess) which seeds pages.

type Params = { id: string };

export const POST = withAuth<Params>(async (req, { user, params }) => {
  // ponytail: withAuth hands us a plain `Request`; parse the query
  // string with stdlib URL instead of NextRequest.nextUrl. Same
  // shape either way — chunksOnly is a single boolean.
  const chunksOnly = new URL(req.url).searchParams.get("chunksOnly") === "true";

  const doc = await findKbDocumentById(user.id, params.id);
  if (!doc) {
    return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  }
  if (doc.status === "pending" || doc.status === "parsing") {
    return NextResponse.json({ code: "PROCESSING" }, { status: 409 });
  }

  // ponytail: chunksOnly needs `pages[].markdown` populated so the
  // graph can skip OCR and go straight to chunking. Without pages
  // the user is asking for "only refresh chunks" on a doc whose OCR
  // never landed — fall back to full reprocess is the recovery path,
  // so we surface 409 with a useful code instead of silently no-op.
  if (chunksOnly) {
    const pages = (doc.pages ?? []) as Array<{ markdown?: string }>;
    const hasUsableMarkdown = pages.some((p) => (p.markdown ?? "").trim().length > 0);
    if (!hasUsableMarkdown) {
      return NextResponse.json(
        { code: "NOT_READY", reason: "doc has no pages[].markdown; run full reprocess first" },
        { status: 409 },
      );
    }

    // ponytail: chunksOnly keeps kb_documents.status untouched — we
    // only wipe chunks inside one tx and dispatch the run.
    await withKbTx(async (tx) => {
      await deleteKbChunksByDocumentId(tx, doc.id);
    });

    // Dispatch — kbAgent prepareKBDataNode reads config.configurable
    // and short-circuits through the chunksOnly branch.
    try {
      await fireIngestionRun({
        userId: user.id,
        // ponytail: chunksOnly doesn't need attachment bytes (no
        // re-render). Pass a minimal stub so the call-site shape
        // stays unified with the full branch — kbAgent ignores
        // attachment fields when mode === "chunksOnly".
        attachment: {
          r2Key: "chunks-only-no-op",
          contentType: doc.contentType,
          name: doc.title,
        },
        docId: doc.id,
        title: doc.title,
        source: "kb-reprocess",
        chunksOnly: true,
      });
    } catch (err) {
      console.error(
        "POST /api/kb/documents/[id]/reprocess?chunksOnly=true: fireIngestionRun failed",
        err,
      );
      // ponytail: unlike the full branch, the doc row never flipped
      // back to pending, so a dispatch failure leaves it at success
      // (truthful state) with stale chunks. The user can re-trigger.
    }

    return NextResponse.json({ docId: doc.id, chunksOnly: true }, { status: 202 });
  }

  // ponytail: full reprocess — clear stale chunks + flip the doc
  // row's status back to "pending" inside one tx so the Settings UI
  // sees a clean state if the deletion succeeds but the dispatch
  // step below fails.
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
