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
//
// Ponytail: R2 cap is 10 MiB (see schema comment) so the synchronous
// arrayBuffer+digest costs ~50ms on the main thread — perceptible but
// not jarring. Bumping past that or running on weaker devices will
// want this moved to a Web Worker; today it's fine inline.
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

// ponytail: PendingAttachment extension — assistant-ui's type doesn't
// carry our cached shaPromise, but we stash one on add() so send() can
// await a hash that's (very likely) already settled. The pre-shim
// path (no shaPromise on the pending) still works: send() falls back
// to computing sha synchronously, the original behavior.
type AttachmentWithSha = PendingAttachment & { shaPromise?: Promise<string | undefined> };

export class R2AttachmentAdapter implements AttachmentAdapter {
  readonly accept: string;

  constructor() {
    this.accept =
      process.env.NEXT_PUBLIC_R2_ALLOWED_CONTENT_TYPES ??
      "image/png,image/jpeg,image/webp,application/pdf";
  }

  async add({ file }: { file: File }): Promise<PendingAttachment> {
    // ponytail: kick off SHA-256 in the background so it's (very likely)
    // settled by the time the user hits Send. add() returns immediately;
    // the digest runs on the main thread but for the 10 MiB R2 cap the
    // worst case is ~50ms, which is fine. The promise lives on the
    // pending object and send() awaits it — if it's not there (old call
    // sites, mocked pendings) send() computes on demand.
    const shaPromise = sha256Hex(file);

    return {
      id: crypto.randomUUID(),
      type: isImageType(file.type) ? "image" : "file",
      name: file.name,
      contentType: file.type,
      file,
      status: { type: "requires-action", reason: "composer-send" },
      ...({ shaPromise } as { shaPromise: Promise<string | undefined> }),
    } as PendingAttachment;
  }

  async send(pending: PendingAttachment): Promise<CompleteAttachment> {
    const file = pending.file;
    if (!file) throw new Error("send() requires the original File (lost between add and send)");

    const type = pending.type === "image" ? "image" : "file";

    // ponytail: reuse the sha computation started in add() when present.
    // A typical user drags a file and then types for 5-30s before Send,
    // which is plenty of time for crypto.subtle to finish — Send's
    // first network round-trip (presign) goes out with sha in hand.
    const sha = await ((pending as AttachmentWithSha).shaPromise ?? sha256Hex(file));

    // TEMP TEST ONLY: PDF → raw base64 (replaces R2 publicUrl for PDFs).
    // SDK's getMessageContent hardcodes source_type:"base64" for file parts.
    // LangChain's ChatOpenAI converter (completions.js:90) then prepends
    // `data:${mime_type};base64,` itself — so we MUST send RAW base64 here,
    // not a full data URL. Sending the full data URL produces a doubled
    // prefix ("data:...;base64,data:...;base64,...") and OpenAI rejects it
    // with "invalid base64-encoded value". Drop this block once issue #12
    // ships the PDF→markdown text path.
    let pdfBase64Raw: string | undefined;
    if (file.type === "application/pdf") {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      pdfBase64Raw = btoa(binary); // raw base64, no data: prefix
    }

    // 1. presign — inserts the DB row (status='pending') and returns the
    //    server-generated id we'll use to confirm. Q2: pass sha256 so the
    //    server can dedup against an existing uploaded row.
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

    // Q2: dedup hit — the row is already 'uploaded' and presign returned
    // the existing publicUrl. Zero network from here: skip both PUT
    // and confirm (confirm's only useful side-effect is HEAD + status
    // flip, both already done at presign time on the dedup path).
    if (presign.skipUpload) {
      return {
        id: presign.id,
        type: pending.type,
        name: pending.name,
        contentType: pending.contentType ?? presign.contentType,
        status: { type: "complete" },
        content: buildContent(
          pdfBase64Raw ?? presign.publicUrl,
          presign.contentType,
          pending.name,
          type,
        ),
      };
    }

    // 1. PUT — direct upload to R2 via the presigned URL.
    const putRes = await fetch(presign.uploadUrl, {
      method: "PUT",
      headers: presign.uploadHeaders,
      body: file,
    });
    if (!putRes.ok) {
      throw new Error(`upload to R2 failed: ${putRes.status}`);
    }

    // 2. confirm — HeadObject verifies size and flips status to 'uploaded'.
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
      content: buildContent(
        pdfBase64Raw ?? confirm.publicUrl,
        confirm.contentType,
        pending.name,
        type,
      ),
    };
  }

  async remove(_attachment: Attachment): Promise<void> {
    // No DB row exists until send() completes, and once it does the
    // attachment is part of a sent message — composer-level remove is a
    // no-op in both directions.
  }
}
