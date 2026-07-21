import { toast } from "sonner";

export const TOAST_DESCRIPTION_CLASS = "!text-foreground";

// ponytail: shared reprocess mode vocabulary. The reprocess dialog
// shows full {title, description} per option; the observability popover
// shows just title alongside the source label. Keeping a single source
// of truth means the two surfaces can never disagree on what a mode
// means.
export type ReprocessMode = "full" | "chunksOnly" | "retryFailed" | "retryFailedChunks";

export type ModeInfo = { title: string; description: string };

const MODE_INFO: Record<ReprocessMode, ModeInfo> = {
  full: {
    title: "Full run",
    description: "Re-render the PDF, re-run OCR, then re-chunk and re-embed.",
  },
  chunksOnly: {
    title: "Chunks only",
    description: "Skip OCR — reuse the cached pages markdown to rebuild chunks + entities.",
  },
  retryFailed: {
    title: "Retry failed OCR",
    description: "Re-OCR failed pages only, keep successful pages, then rebuild chunks.",
  },
  retryFailedChunks: {
    title: "Retry failed chunks",
    description: "Keep successful chunks, only re-embed + re-extract entities for failed ones.",
  },
};

export function getModeInfo(mode: ReprocessMode): ModeInfo {
  return MODE_INFO[mode];
}

export async function sha256Hex(file: File): Promise<string | undefined> {
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

export async function handleAddDoc(
  file: File,
  folderId: string,
  onRefresh: () => Promise<void> | void,
): Promise<boolean> {
  try {
    const sha = await sha256Hex(file);
    const presignRes = await fetch("/api/attachments/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: file.name,
        contentType: file.type,
        sizeBytes: file.size,
        ...(sha ? { sha256: sha } : {}),
      }),
    });
    if (!presignRes.ok) {
      throw await readApiError(presignRes, "presign");
    }
    const presign = (await presignRes.json()) as {
      id: string;
      uploadUrl: string;
      uploadHeaders: Record<string, string>;
      publicUrl: string;
      skipUpload?: boolean;
    };

    if (!presign.skipUpload) {
      const putRes = await fetch(presign.uploadUrl, {
        method: "PUT",
        headers: presign.uploadHeaders,
        body: file,
      });
      if (!putRes.ok) throw await readApiError(putRes, "upload");

      const confirmRes = await fetch(`/api/attachments/${presign.id}/confirm`, { method: "POST" });
      if (!confirmRes.ok) throw await readApiError(confirmRes, "confirm");
    }

    const uploadRes = await fetch("/api/kb/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderId, attachmentId: presign.id, title: file.name }),
    });
    if (!uploadRes.ok && uploadRes.status !== 202) {
      throw await readApiError(uploadRes, "kb upload");
    }
    if (uploadRes.status === 200) {
      const body = (await uploadRes.json()) as { deduped?: boolean; doc?: { title?: string } };
      if (body.deduped) {
        toast.info("Already in knowledge base", {
          descriptionClassName: TOAST_DESCRIPTION_CLASS,
          description: `「${body.doc?.title ?? file.name}」was previously uploaded — skipped duplicate.`,
        });
      }
    } else if (uploadRes.status === 202) {
      const body = (await uploadRes.json()) as { doc?: { title?: string } };
      toast.success("Upload queued", {
        descriptionClassName: TOAST_DESCRIPTION_CLASS,
        description: `「${body.doc?.title ?? file.name}」is being ingested. Status will flip Pending → Parsing → Ready.`,
      });
    }
    void onRefresh();
    return true;
  } catch (err) {
    console.error("Add Doc failed", err);
    const { title, description } = describeAddDocError(err, file.name);
    toast.error(title, {
      descriptionClassName: TOAST_DESCRIPTION_CLASS,
      description,
    });
    return false;
  }
}

// ponytail: parse the API's structured error body (`{code, message?, ...}`)
// into a thrown Error that carries enough context for `describeAddDocError`
// to render a user-friendly toast. Falls back to a plain `HTTP {status}`
// message if the body isn't JSON or doesn't carry a `code`.
async function readApiError(res: Response, stage: string): Promise<AddDocError> {
  const body = (await res.json().catch(() => ({}))) as {
    code?: string;
    message?: string;
    maxBytes?: number;
    sizeBytes?: number;
  };
  return new AddDocError({
    message: body.message ?? `HTTP ${res.status}`,
    stage,
    status: res.status,
    code: body.code,
    maxBytes: body.maxBytes,
    sizeBytes: body.sizeBytes,
  });
}

class AddDocError extends Error {
  readonly stage: string;
  readonly status: number;
  readonly code?: string;
  readonly maxBytes?: number;
  readonly sizeBytes?: number;
  constructor(opts: {
    message: string;
    stage: string;
    status: number;
    code?: string;
    maxBytes?: number;
    sizeBytes?: number;
  }) {
    super(opts.message);
    this.name = "AddDocError";
    this.stage = opts.stage;
    this.status = opts.status;
    this.code = opts.code;
    this.maxBytes = opts.maxBytes;
    this.sizeBytes = opts.sizeBytes;
  }
}

// ponytail: map known API error codes to user-facing titles + descriptions.
// FILE_TOO_LARGE gets MB formatting because the raw byte counts read poorly;
// everything else falls back to the stage + status code so the user at least
// knows which step failed (presign / upload / confirm / kb upload).
function describeAddDocError(
  err: unknown,
  fileName: string,
): { title: string; description: string } {
  if (err instanceof AddDocError) {
    if (err.code === "FILE_TOO_LARGE" && typeof err.maxBytes === "number") {
      return {
        title: "File too large",
        description: `「${fileName}」is ${formatMb(err.sizeBytes)}, limit is ${formatMb(err.maxBytes)}.`,
      };
    }
    if (err.code === "CONTENT_TYPE_NOT_ALLOWED") {
      return {
        title: "File type not supported",
        description: `「${fileName}」isn't in the allowed list. Check the supported formats in the dialog.`,
      };
    }
    // ponytail: with a code but no special case, surface both so the
    // user can search by code and knows which step failed.
    if (err.code) {
      return {
        title: `Upload failed (${err.stage})`,
        description: `${err.code}${err.message ? `: ${err.message}` : ""}`,
      };
    }
    // ponytail: no code at all (non-JSON body, network error). Still
    // tell the user which step failed.
    return {
      title: `Upload failed (${err.stage})`,
      description: err.message || `HTTP ${err.status}`,
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { title: "Upload failed", description: msg };
}

function formatMb(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "?";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
