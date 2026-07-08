import type {
  Attachment,
  AttachmentAdapter,
  CompleteAttachment,
  PendingAttachment,
} from "@assistant-ui/react";

// ponytail: a single round-trip per file. The presign step issues a DB
// row, the PUT goes straight to R2, and send() flips the row to
// 'uploaded' via HEAD. remove() is best-effort DELETE — pending uploads
// are tombstoned on the server side even if the browser tab closes.

type Options = {
  // Reads the active thread id lazily; null when the composer is on a
  // fresh un-named thread (assistant-ui uses a __LOCALID_* placeholder
  // until the user explicitly switches — pass null then, the row gets
  // a NULL thread_id and the (thread_id, created_at) join backfills later).
  getCurrentThreadId: () => string | null;
};

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

export class R2AttachmentAdapter implements AttachmentAdapter {
  readonly accept: string;
  private readonly getCurrentThreadId: () => string | null;

  constructor(opts: Options) {
    this.getCurrentThreadId = opts.getCurrentThreadId;
    // The composer reads `accept` verbatim and feeds it to <input type="file">,
    // so the NEXT_PUBLIC_R2_ALLOWED_CONTENT_TYPES env (which the server also
    // reads for validation) is the single source of truth.
    this.accept =
      process.env.NEXT_PUBLIC_R2_ALLOWED_CONTENT_TYPES ??
      "image/png,image/jpeg,image/webp,application/pdf";
  }

  async add({ file }: { file: File }): Promise<PendingAttachment> {
    const presignRes = await fetch("/api/attachments/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: file.name,
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        threadId: this.getCurrentThreadId() ?? undefined,
      }),
    });
    if (!presignRes.ok) {
      const detail = await presignRes.json().catch(() => ({}));
      throw new Error(
        `presign failed: ${presignRes.status} ${(detail as { code?: string }).code ?? ""}`,
      );
    }
    const { id, uploadUrl, uploadHeaders } = (await presignRes.json()) as {
      id: string;
      uploadUrl: string;
      uploadHeaders: Record<string, string>;
    };

    const putRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: uploadHeaders,
      body: file,
    });
    if (!putRes.ok) {
      throw new Error(`upload to R2 failed: ${putRes.status}`);
    }

    return {
      id,
      type: isImageType(file.type) ? "image" : "file",
      name: file.name,
      contentType: file.type,
      file,
      status: { type: "requires-action", reason: "composer-send" },
    };
  }

  async send(pending: PendingAttachment): Promise<CompleteAttachment> {
    const res = await fetch(`/api/attachments/${pending.id}/confirm`, {
      method: "POST",
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(`confirm failed: ${res.status} ${(detail as { code?: string }).code ?? ""}`);
    }
    const { publicUrl, contentType } = (await res.json()) as {
      publicUrl: string;
      contentType: string;
    };
    const type = pending.type === "image" ? "image" : "file";
    return {
      id: pending.id,
      type: pending.type,
      name: pending.name,
      contentType: pending.contentType ?? contentType,
      status: { type: "complete" },
      content: buildContent(publicUrl, contentType, pending.name, type),
    };
  }

  async remove(attachment: Attachment): Promise<void> {
    // Once the attachment is part of a sent message, the user can only
    // delete the whole message — remove() is for composer chips.
    if (attachment.status.type === "complete") return;
    try {
      await fetch(`/api/attachments/${attachment.id}`, { method: "DELETE" });
    } catch {
      // Best-effort: the row + R2 object may already be gone (orphan
      // cleanup or another tab's remove() call). Swallow the error —
      // surfacing it to the user gives them nothing actionable.
    }
  }
}
