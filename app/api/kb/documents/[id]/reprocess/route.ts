import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/with-auth";
import { fireIngestionRun } from "@/lib/kb/ingest";
import { getAttachmentForUser } from "@/lib/attachments/queries";
import {
  deleteKbChunksByDocumentId,
  deleteKbEntitiesByDocumentId,
  deleteKbRelationshipsByDocumentId,
  findKbDocumentById,
  markFailedKbChunksRetryingByDocumentId,
  resetKbDocumentForReprocess,
  updateKbDocumentStatus,
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
  // string with stdlib URL instead of NextRequest.nextUrl.
  const modeParam = new URL(req.url).searchParams.get("mode");
  const chunksOnly = new URL(req.url).searchParams.get("chunksOnly") === "true";

  let mode: "full" | "chunksOnly" | "retryFailed" | "retryFailedChunks" = "full";
  if (modeParam === "chunksOnly" || chunksOnly) {
    mode = "chunksOnly";
  } else if (modeParam === "retryFailed") {
    mode = "retryFailed";
  } else if (modeParam === "retryFailedChunks") {
    // ponytail: 4th reprocess mode — only re-run chunks whose status
    // is 'failed'. Successful chunks keep their id/embedding/
    // entities verbatim; doc.status stays 'success' so the live UI
    // doesn't flicker to "Indexing" while chunks heal in the
    // background. Surfaces the partial-chunk-failure case without
    // paying OCR cost again.
    mode = "retryFailedChunks";
  }

  const doc = await findKbDocumentById(user.id, params.id);
  if (!doc) {
    return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  }
  if (doc.status === "pending" || doc.status === "parsing") {
    return NextResponse.json({ code: "PROCESSING" }, { status: 409 });
  }

  // ponytail: chunksOnly and retryFailed both bypass re-rendering pages,
  // requiring doc.pages to be populated first.
  if (mode === "chunksOnly" || mode === "retryFailed") {
    const pages = (doc.pages ?? []) as Array<{ markdown?: string }>;
    if (pages.length === 0) {
      return NextResponse.json(
        { code: "NOT_READY", reason: "doc has no pages; run full reprocess first" },
        { status: 409 },
      );
    }

    if (mode === "chunksOnly") {
      const hasUsableMarkdown = pages.some((p) => (p.markdown ?? "").trim().length > 0);
      if (!hasUsableMarkdown) {
        return NextResponse.json(
          { code: "NOT_READY", reason: "doc has no pages[].markdown; run full reprocess first" },
          { status: 409 },
        );
      }
    }

    // ponytail: wipe chunks + entity / relationship rows inside one tx.
    // kb_theme cascades from chunks; entity / relationship DELETEs run
    // here for the same reason as full mode — chunk re-extraction
    // produces new chunkIds, and the old source_chunk_ids arrays would
    // otherwise accumulate forever with dangling references.
    await withKbTx(async (tx) => {
      await deleteKbChunksByDocumentId(tx, doc.id);
      await deleteKbEntitiesByDocumentId(tx, doc.id);
      await deleteKbRelationshipsByDocumentId(tx, doc.id);
    });

    if (mode === "retryFailed") {
      // update document status to parsing so live UI gets polling feedback!
      await updateKbDocumentStatus(user.id, doc.id, {
        status: "parsing",
        errorMessage: null,
      });
    }

    try {
      await fireIngestionRun({
        userId: user.id,
        attachment: {
          r2Key: "chunks-only-no-op",
          contentType: doc.contentType,
          name: doc.title,
        },
        docId: doc.id,
        title: doc.title,
        source: "kb-reprocess",
        mode,
      });
    } catch (err) {
      console.error(
        `POST /api/kb/documents/[id]/reprocess?mode=${mode}: fireIngestionRun failed`,
        err,
      );
    }

    return NextResponse.json(
      { docId: doc.id, chunksOnly: mode === "chunksOnly", mode },
      { status: 202 },
    );
  }

  // ponytail: retryFailedChunks — UPDATE failed chunks in place
  // (status='parsing', clear error_message + entities, keep id/
  // ordinal/embedding/content). doc.status STAYS 'success' the
  // whole time — flipping it to 'parsing' would flicker the UI
  // badge and confuse the user ("did my doc break again?"). The
  // chunk-level "Indexed N/M" rollup is the progress signal;
  // doc.status reflects the macro OCR + chunk pipeline state,
  // which hasn't actually changed.
  //
  // Why UPDATE instead of DELETE+INSERT: the DELETE+INSERT design
  // had a race where pageToMarkdownNode skips under chunksOnly /
  // retryFailed, so doc.pages is empty, fullMarkdown is empty, the
  // IIFE inside generateChunkEmbedNode throws — and the DELETE has
  // already run, leaving the doc with N-K chunks and no recovery
  // path. In-place UPDATE makes the row indestructible.
  if (mode === "retryFailedChunks") {
    if (doc.status !== "success") {
      return NextResponse.json(
        {
          code: "NOT_READY",
          reason: "doc has no successfully indexed chunks yet; run full reprocess first",
        },
        { status: 409 },
      );
    }

    await withKbTx(async (tx) => {
      // ponytail: reset failed chunks to status='parsing' so the
      // IIFE can find them and UPDATE them back to success/failed
      // per-row. The row's id, ordinal, embedding, and content are
      // preserved verbatim — embedding API is deterministic so the
      // old vector is still valid for KB search even if the
      // entity-extract LLM fails on this run.
      await markFailedKbChunksRetryingByDocumentId(tx, doc.id);
    });

    try {
      await fireIngestionRun({
        userId: user.id,
        attachment: {
          r2Key: "chunks-only-no-op",
          contentType: doc.contentType,
          name: doc.title,
        },
        docId: doc.id,
        title: doc.title,
        source: "kb-reprocess",
        mode,
      });
    } catch (err) {
      console.error(
        `POST /api/kb/documents/[id]/reprocess?mode=retryFailedChunks: fireIngestionRun failed`,
        err,
      );
    }

    return NextResponse.json({ docId: doc.id, mode }, { status: 202 });
  }

  // ponytail: validate attachment BEFORE the destructive tx — a
  // 409 ATTACHMENT_MISSING must be side-effect-free. Previously the
  // order was delete-then-check; two clicks of "reprocess" against
  // a doc whose R2 source was missing would wipe its chunks first
  // and then surface the missing-attachment error, leaving the user
  // with permanent data loss and no recovery path.
  if (!doc.attachmentId) {
    // ponytail: no attachment means no R2 file to re-OCR. The row
    // stays at its terminal status — the user can re-upload or delete.
    // Surface the gap rather than swallowing it.
    return NextResponse.json({ code: "ATTACHMENT_MISSING" }, { status: 409 });
  }

  const attachment = await getAttachmentForUser(doc.attachmentId, user.id);
  if (!attachment) {
    return NextResponse.json({ code: "ATTACHMENT_MISSING" }, { status: 409 });
  }

  // ponytail: full reprocess — clear stale chunks + entities +
  // relationships (kb_theme cascades from chunks) and flip the doc
  // row's status back to "pending" inside one tx so the Settings UI
  // sees a clean state if the deletion succeeds but the dispatch
  // step below fails. Entity / relationship rows are wiped instead
  // of left for upsert-accumulation — otherwise source_chunk_ids
  // arrays grow forever and old chunkIds become dangling pointers
  // after the new chunk set lands.
  await withKbTx(async (tx) => {
    await deleteKbChunksByDocumentId(tx, doc.id);
    await deleteKbEntitiesByDocumentId(tx, doc.id);
    await deleteKbRelationshipsByDocumentId(tx, doc.id);
    await resetKbDocumentForReprocess(user.id, doc.id);
  });

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
