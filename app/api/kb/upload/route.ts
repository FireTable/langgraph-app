import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { withAuth } from "@/lib/auth/with-auth";
import { fireIngestionRun } from "@/lib/kb/ingest";
import { getAttachmentForUser } from "@/lib/attachments/queries";
import { findKbDocumentByContentHash, findKbFolderById, insertKbDocument } from "@/lib/kb/queries";

// ponytail: Settings → KB → "Add Doc". Frontend uploads the file via
// the existing /api/attachments/presign → PUT → confirm flow first,
// then POSTs the resulting attachmentId + a target folderId here.
// Backend creates a kb_document row (status=pending) and kicks off
// the kbAgent graph — registered as a top-level assistant in
// langgraph.json so the synthetic "ingest this file" thread skips the
// mainAgent router + renameThreadAgent LLM calls. Shared with
// POST /api/kb/documents/[id]/reprocess via lib/kb/ingest.
//
// The run is fire-and-forget: we return 202 with the docId. The
// frontend polls GET /api/kb/documents and watches the row's status
// flip pending → parsing → success.

const Schema = z.object({
  folderId: z.string().min(1),
  attachmentId: z.string().min(1),
  title: z.string().min(1).max(256).optional(),
});

export const POST = withAuth(async (req, { user }) => {
  const body = Schema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ code: "INVALID" }, { status: 400 });
  }
  const { folderId, attachmentId, title } = body.data;

  // 1. Verify attachment belongs to the caller and is uploaded.
  const attachment = await getAttachmentForUser(attachmentId, user.id);
  if (!attachment) {
    return NextResponse.json({ code: "ATTACHMENT_NOT_FOUND" }, { status: 404 });
  }
  if (attachment.status !== "uploaded") {
    return NextResponse.json({ code: "ATTACHMENT_NOT_UPLOADED" }, { status: 409 });
  }

  // 2. Verify target folder belongs to the caller.
  const folder = await findKbFolderById(user.id, folderId);
  if (!folder) {
    return NextResponse.json({ code: "FOLDER_NOT_FOUND" }, { status: 404 });
  }

  // 3. PRIMARY dedup: if a doc with this contentHash already exists,
  // re-fire ingestion if the previous attempt failed/stalled.
  const contentHash = attachment.sha256 ?? `r2key:${attachment.r2Key}`;
  const existing = await findKbDocumentByContentHash(user.id, contentHash);
  if (existing) {
    if (
      existing.status === "pending" ||
      existing.status === "failed" ||
      existing.status === "parsing"
    ) {
      try {
        await fireIngestionRun({
          userId: user.id,
          attachment,
          docId: existing.id,
          title: title ?? existing.title,
        });
      } catch (err) {
        console.error("POST /api/kb/upload: fireIngestionRun failed", err);
      }
    }
    return NextResponse.json({ doc: existing, deduped: true }, { status: 200 });
  }

  // 4. Create the kb_document row (status=pending) so the UI has
  // something to show immediately and a target to update when the run
  // lands.
  const docId = `d-${randomUUID()}`;
  const doc = await insertKbDocument({
    id: docId,
    userId: user.id,
    folderId,
    attachmentId,
    title: title ?? attachment.name,
    contentType: attachment.contentType,
    contentHash,
    status: "pending",
    errorMessage: null,
  });

  // 5. Fire-and-forget kbAgent run.
  try {
    await fireIngestionRun({
      userId: user.id,
      attachment,
      docId: doc.id,
      title: doc.title,
    });
  } catch (err) {
    // The row is already created; the user can retry from the UI.
    console.error("POST /api/kb/upload: fireIngestionRun failed", err);
  }

  return NextResponse.json({ doc }, { status: 202 });
});
