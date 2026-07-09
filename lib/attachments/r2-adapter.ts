import type {
  Attachment,
  AttachmentAdapter,
  CompleteAttachment,
  PendingAttachment,
} from "@assistant-ui/react";

// ponytail: deferred-upload contract. add() just stashes the file on the
// chip — zero network, zero DB row. send() runs the full pipeline
// (presign → PUT → confirm) the moment the user hits Send. Side benefits:
// (1) no orphan pending rows on composer cancel — if the user closes the
//     tab before sending, nothing was ever created;
// (2) no transient "uploading…" UI to design — chip is stable until send;
// (3) adapter is now thread-agnostic (Q3): attachments are not bound to
//     a thread_id column, so the __LOCALID_* vs settled-uuid question
//     never arises.

function isImageType(contentType: string): boolean {
  return contentType.toLowerCase().startsWith("image/");
}

function buildContent(
  publicUrl: string,
  contentType: string,
  name: string,
  type: "image" | "file",
): CompleteAttachment["content"] {
  if (type === "image") {
    return [{ type: "image", image: publicUrl, filename: name }];
  }
  return [{ type: "file", data: publicUrl, mimeType: contentType, filename: name }];
}

// ponytail: SHA-256 as 64-char hex. crypto.subtle is available in all
// modern browsers (https, secure context) and Node 20+. For very old
// clients without subtle crypto we fall through with sha256=undefined
// — the server still accepts the presign, just without dedup.
async function sha256Hex(file: File): Promise<string | undefined> {
  try {
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return undefined;
  }
}

export class R2AttachmentAdapter implements AttachmentAdapter {
  readonly accept: string;

  constructor() {
    this.accept =
      process.env.NEXT_PUBLIC_R2_ALLOWED_CONTENT_TYPES ??
      "image/png,image/jpeg,image/webp,application/pdf";
  }

  async add({ file }: { file: File }): Promise<PendingAttachment> {
    return {
      id: crypto.randomUUID(),
      type: isImageType(file.type) ? "image" : "file",
      name: file.name,
      contentType: file.type,
      file,
      status: { type: "requires-action", reason: "composer-send" },
    };
  }

  async send(pending: PendingAttachment): Promise<CompleteAttachment> {
    const file = pending.file;
    if (!file) throw new Error("send() requires the original File (lost between add and send)");

    const type = pending.type === "image" ? "image" : "file";

    // 1. presign — inserts the DB row (status='pending') and returns the
    //    server-generated id we'll use to confirm. Q2: pass sha256 so the
    //    server can dedup against an existing uploaded row.
    const sha = await sha256Hex(file);
    const presignRes = await fetch("/api/attachments/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: file.name,
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        ...(sha ? { sha256: sha } : {}),
      }),
    });
    if (!presignRes.ok) {
      const detail = (await presignRes.json().catch(() => ({}))) as { code?: string };
      throw new Error(`presign failed: ${presignRes.status} ${detail.code ?? ""}`);
    }
    const presign = (await presignRes.json()) as {
      id: string;
      uploadUrl: string;
      publicUrl: string;
      uploadHeaders: Record<string, string>;
      contentType: string;
      sizeBytes: number;
      skipUpload?: boolean;
    };

    // Q2: dedup hit — the existing row's publicUrl is good enough. Skip
    // the PUT entirely; the row is already 'uploaded' so confirm just
    // returns its metadata. This is the cost-saving path for users who
    // re-attach the same file.
    if (!presign.skipUpload) {
      const putRes = await fetch(presign.uploadUrl, {
        method: "PUT",
        headers: presign.uploadHeaders,
        body: file,
      });
      if (!putRes.ok) {
        throw new Error(`upload to R2 failed: ${putRes.status}`);
      }
    }

    // 2. confirm — HeadObject verifies size (or returns the existing
    // row's metadata on dedup hit).
    const confirmRes = await fetch(`/api/attachments/${presign.id}/confirm`, {
      method: "POST",
    });
    if (!confirmRes.ok) {
      const detail = (await confirmRes.json().catch(() => ({}))) as { code?: string };
      throw new Error(`confirm failed: ${confirmRes.status} ${detail.code ?? ""}`);
    }
    const confirm = (await confirmRes.json()) as { publicUrl: string; contentType: string };

    return {
      id: presign.id,
      type: pending.type,
      name: pending.name,
      contentType: pending.contentType ?? confirm.contentType,
      status: { type: "complete" },
      content: buildContent(confirm.publicUrl, confirm.contentType, pending.name, type),
    };
  }

  async remove(_attachment: Attachment): Promise<void> {
    // No DB row exists until send() completes, and once it does the
    // attachment is part of a sent message — composer-level remove is a
    // no-op in both directions.
  }
}
