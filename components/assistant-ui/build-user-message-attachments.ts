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
//
// kbRefs is the sidecar map populated by kbAgent on the langgraph
// state (filePartData → { docId, attachmentId? }). The SDK filter
// strips standalone `kb_ref` parts AND sibling `kb_ref` fields on
// `file` parts — both paths return null in the SDK's contentToParts
// (the file switch rebuilds the object from scratch with only
// {type, filename, data, mimeType}). So the only place kb_ref
// survives is on the sidecar, and we look it up here per file /
// image part by URL.

type KbRefMarker = { docId: string; attachmentId?: string };

export type BuildUserMessageAttachmentsOptions = {
  kbRefs?: Record<string, KbRefMarker>;
};

// ponytail: image parts in message.content carry only the URL — the
// SDK's `contentToParts` drops `filename` on the round trip through
// `image_url`. R2 keys look like `u/<userId>/<uuid>-<filename>`, so
// the last URL segment is the original filename with the uuid prefix
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

function buildKbRefAttachment(docId: string, name: string, key: string): CompleteAttachment {
  return {
    id: key,
    type: "kb_ref",
    name,
    contentType: "kb_ref",
    status: { type: "complete" },
    content: [{ type: "kb_ref", docId } as unknown as CompleteAttachment["content"][number]],
  };
}

export function buildUserMessageAttachments(
  parts: readonly unknown[],
  options: BuildUserMessageAttachmentsOptions = {},
): CompleteAttachment[] {
  const seen = new Set<string>();
  const out: CompleteAttachment[] = [];
  const kbRefs = options.kbRefs;
  for (const part of parts) {
    const r = asRecord(part);
    const type = r.type;
    let key: string | undefined;
    let complete: CompleteAttachment | undefined;

    if (type === "image" && typeof r.image === "string") {
      const url = r.image;
      const name = filenameFromImageUrl(url);
      const kbRef = kbRefs?.[url];
      if (kbRef) {
        // ponytail: image upload was a PDF (or image that later got
        // ingested into KB). Surface as a KB-doc tile so the user can
        // click through to /settings/knowledge-base?doc=<id>. The image
        // URL stays as the visual; docId drives the deep-link.
        key = `kb_ref:${kbRef.docId}`;
        complete = buildKbRefAttachment(kbRef.docId, name, key);
      } else {
        key = url;
        complete = {
          id: url,
          type: "image",
          name,
          contentType: "image",
          status: { type: "complete" },
          content: [{ type: "image", image: url, filename: name }],
        };
      }
    } else if (type === "file" && typeof r.data === "string") {
      // ponytail: SDK's contentToParts defaults filename to "file"
      // when the source part lacks `metadata.filename`, but the type
      // still allows undefined. Fall back to "file" so we always
      // have a non-empty id / name.
      const fileName = (typeof r.filename === "string" && r.filename) || "file";
      const mimeType = typeof r.mimeType === "string" ? r.mimeType : "";
      const kbRef = kbRefs?.[r.data];
      if (kbRef) {
        // ponytail: kbAgent ingested this PDF; surface the tile as a
        // KB-doc deep-link instead of a generic file preview.
        key = `kb_ref:${kbRef.docId}`;
        complete = buildKbRefAttachment(kbRef.docId, fileName, key);
      } else {
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
      }
    } else if (type === "kb_ref" && typeof r.docId === "string") {
      // ponytail: legacy branch — older threads may have emitted a
      // standalone kb_ref part before the sidecar migration. New
      // ingests rely on the sidecar via the image / file branches
      // above.
      const docId = r.docId;
      key = `kb_ref:${docId}`;
      complete = buildKbRefAttachment(docId, docId, key);
    }
    if (complete && key && !seen.has(key)) {
      seen.add(key);
      out.push(complete);
    }
  }
  return out;
}
