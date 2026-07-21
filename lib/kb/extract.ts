import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { KB_REF_PREFIX, KB_REF_PREFIX_REGEX, KB_REF_SUFFIX } from "@/lib/constants";

// ponytail: pure helpers for inspecting chat messages. No DB / no I/O.
// Wire format follows @assistant-ui/react-langgraph's toLangChainUserMessage:
// camelCase on the client, snake_case on the wire (the runtime renames
// mimeType → mime_type before posting the run). kbAgent and RouterNode
// share these helpers so a wire-format quirk only has to be reasoned
// about in one place.

export type KbRefMarker = {
  docId: string;
  attachmentId?: string;
};

// ponytail: the canonical KB marker on a file part lives as the
// `kb_ref` sibling field. Backend state.messages is append-only and
// never goes through the SDK round-trip, so the sibling survives
// inside the graph. The front-end can't see this sibling — the SDK's
// `contentToParts` rebuilds file parts from scratch with only
// {type, filename, data, mimeType} and drops every other field —
// which is why kbAgent also stamps a `[kb:<docId>]` prefix onto the
// filename in the same write. Both channels are written so the marker
// is visible to back-end helpers AND to the rendered tile layer.
export type FilePart = {
  type: "file";
  data: string;
  url?: string;
  mime_type?: string;
  filename?: string;
  metadata?: Record<string, unknown>;
  kb_ref?: KbRefMarker;
};

// ponytail: legacy standalone kb_ref part shape. Kept so existing
// threads (and the older code paths that produced them) still resolve.
// collectKbRefs and resolveKbRefs both accept this shape. New code
// stamps via the kb_ref sibling (preferred) + filename prefix (front-end
// fallback) instead.
export type KbRefPart = {
  type: "kb_ref";
  docId: string;
  attachmentId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isFilePart(part: unknown): part is FilePart {
  return (
    isRecord(part) &&
    part.type === "file" &&
    (typeof part.data === "string" || typeof part.url === "string")
  );
}

export function isPdfAttachment(part: FilePart): boolean {
  return part.mime_type === "application/pdf";
}

// ponytail: front-end-only helper. Parses the `[kb:<docId>]` prefix off
// a filename. Backend code should read the `kb_ref` sibling field on
// FilePart instead — the sibling is the canonical channel and is the
// one the router / resolve layer look at. The filename prefix exists
// purely because the SDK's contentToParts drops sibling fields on file
// parts, so the front-end has no other way to recover the docId.
export function extractKbRefFromFilename(filename: unknown): { docId: string } | null {
  if (typeof filename !== "string" || filename.length === 0) return null;
  const m = KB_REF_PREFIX_REGEX.exec(filename);
  if (!m) return null;
  const docId = m[1];
  if (typeof docId !== "string" || docId.length === 0) return null;
  return { docId };
}

// ponytail: stamp the prefix onto a filename. Idempotent: a re-stamp
// of an already-stamped filename is a no-op. Empty input degrades to
// the bare bracket form so the marker still survives even when the
// original had no filename.
export function stampKbRefOnFilename(filename: unknown, docId: string): string {
  if (typeof filename !== "string" || filename.length === 0) {
    return `${KB_REF_PREFIX}${docId}${KB_REF_SUFFIX}`;
  }
  if (KB_REF_PREFIX_REGEX.test(filename)) return filename;
  return `${KB_REF_PREFIX}${docId}${KB_REF_SUFFIX} ${filename}`;
}

// ponytail: strip the kb prefix back to a user-facing filename.
// Front-end applies this on every render of `attachment.name` so the
// user never sees the bracket. Mirrors stampKbRefOnFilename's
// idempotency.
export function stripKbRefFromFilename(filename: string | undefined): string {
  if (!filename) return filename ?? "";
  return filename.replace(KB_REF_PREFIX_REGEX, "");
}

// ponytail: KB ingestible mime types — PDFs go through the OCR
// pipeline, markdown / plain text pass through as pre-baked markdown,
// images go through vision OCR. Single source of truth so the router
// signal and the extractor agree on "what kbAgent should eat".
const KB_INGESTIBLE_MIME = new Set(["application/pdf", "text/markdown", "text/plain"]);

function isKbIngestibleMime(mime: string | undefined): boolean {
  if (!mime) return false;
  const lower = mime.toLowerCase();
  if (KB_INGESTIBLE_MIME.has(lower)) return true;
  return lower.startsWith("image/");
}

// ponytail: router signal. True when ANY HumanMessage has a kb-ingestible
// file part without a kb_ref sibling. Once kbAgent stamps the sibling, a
// second router pass won't re-dispatch kbAgent.
export function hasUnprocessedPdf(messages: BaseMessage[]): boolean {
  for (const m of messages) {
    const content = humanContent(m);
    if (!isHumanLike(m) || !Array.isArray(content)) continue;
    if (content.some((p) => isFilePart(p) && isKbIngestibleMime(p.mime_type) && !p.kb_ref)) {
      return true;
    }
  }
  return false;
}

// ponytail: returns every unprocessed kb-ingestible file part from
// every HumanMessage in message order. A kb_ref-stamped part is already
// processed — re-processing would double the chunks. Name kept for
// back-compat (router-agent-node.ts + kb-agent.ts already import it);
// the underlying set widened from PDF-only to all 4 ingestible kinds.
export function extractAllPdfParts(
  messages: BaseMessage[],
): Array<{ messageIndex: number; filePart: FilePart }> {
  const out: Array<{ messageIndex: number; filePart: FilePart }> = [];
  messages.forEach((m, i) => {
    const content = humanContent(m);
    if (!isHumanLike(m) || !Array.isArray(content)) return;
    for (const part of content) {
      if (isFilePart(part) && isKbIngestibleMime(part.mime_type) && !part.kb_ref) {
        out.push({ messageIndex: i, filePart: part });
      }
    }
  });
  return out;
}

// ponytail: a HumanMessage OR a plain `{type:"human", content:[...]}` dict.
// SDK rehydration of input.messages via MessagesValue yields either a
// HumanMessage instance (chat path / in-process local invoke) OR a
// plain object with just `type` + `content` keys (standalone
// `runs.create` path through the langgraph-api worker). Without this
// OR filter the standalone dispatch sees zero PDFs and the kb_document
// row stays `pending`. Mirrors the same idiom in
// backend/node/thread-summarize-node.ts:isHumanMessage.
function isHumanLike(m: BaseMessage): boolean {
  return m instanceof HumanMessage || (m as { type?: unknown }).type === "human";
}
function humanContent(m: BaseMessage): unknown[] | undefined {
  const c = (m as { content?: unknown }).content;
  return Array.isArray(c) ? c : undefined;
}

// ponytail: every kb_ref across every HumanMessage, deduped by docId
// (first occurrence wins). Backend state.messages carries the kb_ref
// as a sibling field on file parts; the legacy `{ type: "kb_ref" }`
// standalone part is still accepted for backward compat. The filename
// prefix is NOT read here — that's front-end only; backend has the
// canonical sibling and that's what resolveKbRefs feeds to the LLM.
//
// state.messages is append-only under the LangGraph addMessages
// reducer, so a kb_ref attached by kbAgent in turn N stays in
// Human(N) for the rest of the thread — even after the user has sent
// several more turns of plain text.
export function collectKbRefs(messages: BaseMessage[]): KbRefPart[] {
  const seen = new Set<string>();
  const out: KbRefPart[] = [];
  for (const m of messages) {
    if (!(m instanceof HumanMessage) || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      let marker: KbRefPart | null = null;

      if (isFilePart(part) && part.kb_ref) {
        marker = {
          type: "kb_ref",
          docId: part.kb_ref.docId,
          attachmentId: part.kb_ref.attachmentId,
        };
      }

      if (marker && !seen.has(marker.docId)) {
        seen.add(marker.docId);
        out.push(marker);
      }
    }
  }
  return out;
}

// ponytail: strip file content parts before sending to the LLM —
// apimart's Azure Responses API rejects image_url/file content with
// non-base64 data ("Invalid file data" 400). The model has already
// routed to kbAgent (kb_ref sibling on every PDF file part) or it's
// not a PDF — either way the file part is irrelevant for routing.
export function stripFileParts(msg: BaseMessage): BaseMessage {
  if (!Array.isArray(msg.content)) return msg;
  const cleaned = msg.content.filter(
    (p) => typeof p === "object" && p !== null && (p as { type?: string }).type !== "file",
  );
  if (cleaned.length === msg.content.length) return msg;
  return new HumanMessage({ content: cleaned as never, id: msg.id });
}
