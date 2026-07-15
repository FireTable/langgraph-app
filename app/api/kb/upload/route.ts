import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { withAuth } from "@/lib/auth/with-auth";
import { langGraphClient } from "@/lib/langgraph/client";
import { getAttachmentForUser } from "@/lib/attachments/queries";
import { findKbDocumentByContentHash, findKbFolderById, insertKbDocument } from "@/lib/kb/queries";

// ponytail: Settings → KB → "Add Doc". Frontend uploads the file via
// the existing /api/attachments/presign → PUT → confirm flow first,
// then POSTs the resulting attachmentId + a target folderId here.
// Backend creates a kb_document row (status=pending) and kicks off
// a LangGraph run that re-uses kbAgent — same code path as the chat
// upload, just invoked from settings instead of the composer.
//
// The run is fire-and-forget: we register a thread, dispatch the run,
// and return 202 with the docId. The frontend polls GET /api/kb/documents
// and watches the row's status flip pending → parsing → success.

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

  // 3. PRIMARY dedup: if a doc with this contentHash already exists, link
  // the new folder+attachment into it (or just return the existing row
  // and re-fire ingestion if the previous attempt failed).
  const contentHash = attachment.sha256 ?? `r2key:${attachment.r2Key}`;
  const existing = await findKbDocumentByContentHash(user.id, contentHash);
  if (existing) {
    // Re-fire ingestion in case the previous attempt failed/stalled.
    if (
      existing.status === "pending" ||
      existing.status === "failed" ||
      existing.status === "parsing"
    ) {
      await fireIngestionRun(user.id, attachment, existing.id, title ?? existing.title);
    }
    return NextResponse.json({ doc: existing, deduped: true }, { status: 200 });
  }

  // 4. Create the kb_document row (status=pending) so the UI has something
  // to show immediately and a target to update when the run lands.
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

  // 5. Fire-and-forget LangGraph run (kbAgent path). We don't await the
  // run's completion — the run mutates the kb_document row via the
  // graph's normal flow (status flips to parsing → success / failed).
  try {
    await fireIngestionRun(user.id, attachment, docId, doc.title);
  } catch (err) {
    // The row is already created; the user can retry from the UI.
    console.error("POST /api/kb/upload: fireIngestionRun failed", err);
  }

  return NextResponse.json({ doc }, { status: 202 });
});

async function fireIngestionRun(
  userId: string,
  attachment: { r2Key: string; contentType: string; name: string },
  docId: string,
  title: string,
): Promise<void> {
  const base = process.env.R2_PUBLIC_BASE_URL ?? "";
  const publicUrl = `${base}/${attachment.r2Key}`;

  const threadId = `t-${randomUUID()}`;
  // ponytail: register the thread id with the dev server's in-process
  // checkpointer (see lib/langgraph/client.ts). No-op in prod.
  await langGraphClient.threads.create({ threadId, ifExists: "do_nothing" });

  // JSON-serializable message shape — the graph's MessagesValue reducer
  // reconstructs HumanMessage on the server. file_part matches the
  // assistant-ui wire format that kbAgent's router expects.
  const input = {
    messages: [
      {
        type: "human",
        content: [
          { type: "text", text: "ingest this file" },
          {
            type: "file",
            data: publicUrl,
            mime_type: attachment.contentType,
            filename: attachment.name,
          },
        ],
      },
    ],
  };

  const config = {
    configurable: {
      userId,
      thread_id: threadId,
    },
  };

  // Fire-and-forget: don't await run completion. The graph runs in the
  // background; kbAgent mutates the kb_document row's status as it
  // progresses. `after: ["kbAgent"]` would limit wait to that subgraph,
  // but we want the whole chat-stream to finish (so renameThreadAgent
  // runs in parallel). `wait: false` is the SDK's fire-and-forget mode.
  void langGraphClient.runs.create(threadId, "agent", {
    input,
    config,
    metadata: { source: "kb-settings", docId, title },
  });
}
