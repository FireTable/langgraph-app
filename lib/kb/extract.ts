import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

// ponytail: pure helpers for inspecting chat messages. No DB / no I/O.
// Wire format follows @assistant-ui/react-langgraph's toLangGraphUserMessage:
// camelCase on the client, snake_case on the wire (the runtime renames
// mimeType → mime_type before posting the run). kbAgent and RouterNode
// share these helpers so a wire-format quirk only has to be reasoned
// about in one place.

export type KbRefMarker = {
  docId: string;
  attachmentId?: string;
};

// ponytail: kb_ref rides as a sibling field on a file part, NOT as
// its own content part. Reason: @assistant-ui/react-langgraph's
// `contentToParts` only forwards a closed set of part types (text,
// image, file, reasoning, tool-call, computer_call) and a standalone
// `{ type: "kb_ref" }` hits the default branch and gets filtered to
// null. The SDK's `file` switch ALSO rebuilds the object from scratch
// with only {type, filename, data, mimeType} — sibling fields might
// get dropped there too, but we try the sibling-field approach first
// because it's the most direct path; if it doesn't survive, fall
// back to patching the SDK or a custom message converter.
export type FilePart = {
  type: "file";
  data: string;
  mime_type?: string;
  filename?: string;
  kb_ref?: KbRefMarker;
};

// ponytail: legacy standalone kb_ref part shape. Kept for type-compat
// with old threads that predate the sibling-field migration AND for
// the resolve layer that needs to read kb_refs to feed the LLM.
// collectKbRefs accepts both shapes.
export type KbRefPart = {
  type: "kb_ref";
  docId: string;
  attachmentId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isFilePart(part: unknown): part is FilePart {
  return isRecord(part) && part.type === "file" && typeof part.data === "string";
}

export function isKbRefPart(part: unknown): part is KbRefPart {
  return isRecord(part) && part.type === "kb_ref" && typeof part.docId === "string";
}

export function isPdfAttachment(part: FilePart): boolean {
  return part.mime_type === "application/pdf";
}

// ponytail: router signal. True when ANY HumanMessage in the array
// still carries a PDF file part (without a kb_ref sibling — a
// kb_ref-stamped PDF is already processed). Returns false for
// already-ingested PDFs so a second router pass doesn't re-dispatch
// kbAgent.
export function hasUnprocessedPdf(messages: BaseMessage[]): boolean {
  for (const m of messages) {
    if (!(m instanceof HumanMessage) || !Array.isArray(m.content)) continue;
    if (m.content.some((p) => isFilePart(p) && p.mime_type === "application/pdf" && !p.kb_ref)) {
      return true;
    }
  }
  return false;
}

// ponytail: returns EVERY PDF file part from EVERY HumanMessage in
// message order, EXCLUDING those already stamped with a kb_ref
// sibling (kbAgent has already processed them — re-processing would
// double the chunks). kbAgent uses this to discover what needs OCR.
export function extractAllPdfParts(
  messages: BaseMessage[],
): Array<{ messageIndex: number; filePart: FilePart }> {
  const out: Array<{ messageIndex: number; filePart: FilePart }> = [];
  messages.forEach((m, i) => {
    if (!(m instanceof HumanMessage) || !Array.isArray(m.content)) return;
    for (const part of m.content) {
      if (isFilePart(part) && part.mime_type === "application/pdf" && !part.kb_ref) {
        out.push({ messageIndex: i, filePart: part });
      }
    }
  });
  return out;
}

// ponytail: returns every kb_ref across EVERY HumanMessage, deduped
// by docId (first occurrence wins). Accepts both the new
// file-part-with-kb_ref-sibling shape AND the legacy standalone
// kb_ref part. state.messages is append-only under the LangGraph
// addMessages reducer, so a kb_ref attached by kbAgent in turn N
// stays in Human(N) for the rest of the thread — even after the
// user has sent several more turns of plain text. Used by
// resolveKbRefs to feed the LLM the full history.
export function collectKbRefs(messages: BaseMessage[]): KbRefPart[] {
  const seen = new Set<string>();
  const out: KbRefPart[] = [];
  for (const m of messages) {
    if (!(m instanceof HumanMessage) || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      const marker =
        isFilePart(part) && part.kb_ref ? part.kb_ref : isKbRefPart(part) ? part : null;
      if (marker && !seen.has(marker.docId)) {
        seen.add(marker.docId);
        out.push({ type: "kb_ref", docId: marker.docId, attachmentId: marker.attachmentId });
      }
    }
  }
  return out;
}
