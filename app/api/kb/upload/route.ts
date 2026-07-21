import { NextResponse } from "next/server";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

import { withAuth } from "@/lib/auth/with-auth";
import { fireIngestionRun } from "@/lib/kb/ingest";
import { fetchUrlToMarkdown } from "@/lib/kb/url";
import { getAttachmentForUser, findUploadedBySha } from "@/lib/attachments/queries";
import { buildKey } from "@/lib/attachments/keys";
import { insertAttachment } from "@/lib/attachments/queries";
import { findKbDocumentByContentHash, findKbFolderById, insertKbDocument } from "@/lib/kb/queries";
import { putObject } from "@/lib/r2/client";

// ponytail: Settings → KB → "Add Doc" + URL flow. The frontend uploads
// the file via /api/attachments/presign → PUT → confirm first, then
// POSTs the resulting attachmentId here. URL flow short-circuits that:
// server fetches → PUTs bytes → inserts attachments row → fires
// fireIngestionRun just like the file path. One route, two entry
// shapes, same downstream pipeline.

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const ID_LEN = 12;

// ponytail: 12-char nanoid-style id (~71 bits), matches the existing
// attachments presign route's id scheme. Modulo bias is negligible at
// this alphabet length.
function generateId(): string {
  const bytes = randomBytes(ID_LEN);
  let out = "";
  for (let i = 0; i < ID_LEN; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

const Schema = z
  .object({
    folderId: z.string().min(1),
    attachmentId: z.string().min(1).optional(),
    url: z.url().optional(),
    title: z.string().min(1).max(256).optional(),
  })
  .refine((d) => d.attachmentId || d.url, {
    message: "either attachmentId or url is required",
  });

export const POST = withAuth(async (req, { user }) => {
  const body = Schema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ code: "INVALID" }, { status: 400 });
  }
  const { folderId, attachmentId, url, title } = body.data;

  // 1. Verify target folder belongs to the caller.
  const folder = await findKbFolderById(user.id, folderId);
  if (!folder) {
    return NextResponse.json({ code: "FOLDER_NOT_FOUND" }, { status: 404 });
  }

  // 2. Resolve to (attachment, dedupContentHash, displayTitle).
  //    File path reads attachmentId; URL path fetches + writes a new
  //    attachment server-side and returns it.
  const resolved = url
    ? await ingestFromUrl({ userId: user.id, url, title })
    : await resolveAttachment({ userId: user.id, attachmentId: attachmentId! });

  if ("error" in resolved) {
    return NextResponse.json({ code: resolved.code }, { status: resolved.status });
  }

  const { attachment, contentHash, displayTitle } = resolved;

  // 3. PRIMARY dedup: if a doc with this contentHash already exists,
  // re-fire ingestion if the previous attempt failed/stalled.
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
    attachmentId: attachment.id,
    title: displayTitle,
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

// ponytail: file flow. Looks up the existing attachments row written
// by the presign→confirm sequence, validates ownership + status.
async function resolveAttachment({
  userId,
  attachmentId,
}: {
  userId: string;
  attachmentId: string;
}): Promise<
  | {
      attachment: {
        id: string;
        r2Key: string;
        contentType: string;
        name: string;
        sha256: string | null;
      };
      contentHash: string;
      displayTitle: string;
    }
  | { error: true; code: string; status: number }
> {
  const attachment = await getAttachmentForUser(attachmentId, userId);
  if (!attachment) {
    return { error: true, code: "ATTACHMENT_NOT_FOUND", status: 404 };
  }
  if (attachment.status !== "uploaded") {
    return { error: true, code: "ATTACHMENT_NOT_UPLOADED", status: 409 };
  }
  const contentHash = attachment.sha256 ?? `r2key:${attachment.r2Key}`;
  return {
    attachment: {
      id: attachment.id,
      r2Key: attachment.r2Key,
      contentType: attachment.contentType,
      name: attachment.name,
      sha256: attachment.sha256,
    },
    contentHash,
    displayTitle: attachment.name,
  };
}

// ponytail: URL flow. Server-side fetch → sha256 → R2 put → attachments
// row. Returns the same shape as resolveAttachment so the rest of the
// route is unified.
async function ingestFromUrl({
  userId,
  url,
  title,
}: {
  userId: string;
  url: string;
  title?: string;
}): Promise<{
  attachment: { id: string; r2Key: string; contentType: string; name: string; sha256: string };
  contentHash: string;
  displayTitle: string;
}> {
  const page = await fetchUrlToMarkdown(url);
  const bytes = Buffer.from(page.markdown, "utf-8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  // ponytail: dedup at the attachments layer too — the
  // (user_id, sha256, status='uploaded') unique index would 500 the
  // INSERT if a prior URL ingestion left an attachments row behind.
  // Reuse it (R2 bytes already there from the original putObject).
  const existing = await findUploadedBySha(userId, sha256);
  if (existing) {
    return {
      attachment: {
        id: existing.id,
        r2Key: existing.r2Key,
        contentType: existing.contentType,
        name: existing.name,
        sha256,
      },
      contentHash: sha256,
      displayTitle: title ?? existing.name.replace(/\.md$/, ""),
    };
  }

  const id = generateId();
  // ponytail: caller-supplied title wins, then jina-derived H1/title,
  // then URL path. Empty-string from page.title would render as a
  // blank row in the UI — coerce to undefined so the URL fallback kicks in.
  const displayTitle = title ?? (page.title?.trim() || url);
  const r2Key = buildKey(userId, id, `${displayTitle}.md`);
  await putObject({ key: r2Key, body: bytes, contentType: "text/markdown" });

  const row = await insertAttachment({
    id,
    userId,
    r2Key,
    name: `${displayTitle}.md`,
    contentType: "text/markdown",
    sizeBytes: bytes.byteLength,
    sha256,
    status: "uploaded",
    confirmedAt: new Date(),
  });

  return {
    attachment: {
      id: row.id,
      r2Key: row.r2Key,
      contentType: row.contentType,
      name: row.name,
      sha256,
    },
    contentHash: sha256,
    displayTitle,
  };
}
