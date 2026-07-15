import type { CompleteAttachment } from "@assistant-ui/react";

// ponytail: pure projection of message.content → CompleteAttachment[].
// Mirrors the loop body that used to live inside UserMessageAttachments'
// useMemo, hoisted so the kb_ref branch is testable without mounting
// the aUI runtime. image / file branches preserved verbatim.
//
// The aUI runtime's `useAuiState(s => s.message.content)` is typed as
// `readonly (TextMessagePart | ThreadUserMessagePart | ThreadAssistantMessagePart)[]`
// but at runtime it carries our custom kb_ref parts too — we accept
// `readonly unknown[]` here and narrow with structural checks, same as
// the original code did for image/file.

// ponytail: image parts in message.content carry only the URL — the
// SDK's `contentToParts` drops `filename` on the round trip through
// `image_url`. R2 keys look like `u/<userId>/<uuid>-<filename>`, so the
// last URL segment is the original filename with the uuid prefix
// stripped.
function filenameFromImageUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").pop() ?? "";
    const decoded = decodeURIComponent(last);
    const stripped = decoded.replace(/^[0-9a-f-]{36}-/, "");
    return stripped || "image";
  } catch {
    return "image";
  }
}

function asRecord(part: unknown): Record<string, unknown> {
  return part as Record<string, unknown>;
}

export function buildUserMessageAttachments(parts: readonly unknown[]): CompleteAttachment[] {
  const seen = new Set<string>();
  const out: CompleteAttachment[] = [];
  for (const part of parts) {
    const r = asRecord(part);
    const type = r.type;
    let key: string | undefined;
    let complete: CompleteAttachment | undefined;

    if (type === "image" && typeof r.image === "string") {
      const name = filenameFromImageUrl(r.image);
      key = r.image;
      complete = {
        id: r.image,
        type: "image",
        name,
        contentType: "image",
        status: { type: "complete" },
        content: [{ type: "image", image: r.image, filename: name }],
      };
    } else if (type === "file" && typeof r.data === "string") {
      // ponytail: SDK's contentToParts defaults filename to "file"
      // when the source part lacks `metadata.filename`, but the type
      // still allows undefined. Fall back to "file" so we always
      // have a non-empty id / name.
      const fileName = (typeof r.filename === "string" && r.filename) || "file";
      const mimeType = typeof r.mimeType === "string" ? r.mimeType : "";
      key = fileName;
      complete = {
        id: fileName,
        type: "file",
        name: fileName,
        contentType: mimeType,
        status: { type: "complete" },
        content: [
          {
            type: "file",
            data: r.data,
            mimeType,
            filename: fileName,
          },
        ],
      };
    } else if (type === "kb_ref" && typeof r.docId === "string") {
      // ponytail: kb_ref is a runtime-only part type we inject via
      // backend/agent/kb-agent.ts after a PDF gets ingested. The aUI
      // type union doesn't include it, so we narrow via duck-typing
      // and surface it as its own attachment kind. DocId doubles as
      // both the dedup key and the route param for the KB settings
      // deep-link. Content part carries the kb_ref marker so downstream
      // renderers (MessageAttachmentCard) can pull the docId without
      // reaching back into the original message.
      const docId = r.docId;
      key = `kb_ref:${docId}`;
      complete = {
        id: key,
        type: "kb_ref",
        name: docId,
        contentType: "kb_ref",
        status: { type: "complete" },
        content: [{ type: "kb_ref", docId } as unknown as CompleteAttachment["content"][number]],
      };
    }
    if (complete && key && !seen.has(key)) {
      seen.add(key);
      out.push(complete);
    }
  }
  return out;
}
