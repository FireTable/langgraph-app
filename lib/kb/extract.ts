import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

// ponytail: pure helpers for inspecting chat messages. No DB / no I/O.
// Wire format follows @assistant-ui/react-langgraph's toLangGraphUserMessage:
// camelCase on the client, snake_case on the wire (the runtime renames
// mimeType → mime_type before posting the run). kbAgent and RouterNode
// share these helpers so a wire-format quirk only has to be reasoned
// about in one place.

export type FilePart = {
  type: "file";
  data: string;
  mime_type?: string;
  filename?: string;
};

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
// still carries a PDF file part. Once kbAgent finishes, every PDF
// file part has been replaced with a kb_ref, so this returns false
// until the next upload.
export function hasUnprocessedPdf(messages: BaseMessage[]): boolean {
  for (const m of messages) {
    if (!(m instanceof HumanMessage) || !Array.isArray(m.content)) continue;
    if (m.content.some((p) => isFilePart(p) && p.mime_type === "application/pdf")) {
      return true;
    }
  }
  return false;
}

// ponytail: returns EVERY PDF file part from EVERY HumanMessage in
// message order. kbAgent uses this to discover what needs OCR.
export function extractAllPdfParts(
  messages: BaseMessage[],
): Array<{ messageIndex: number; filePart: FilePart }> {
  const out: Array<{ messageIndex: number; filePart: FilePart }> = [];
  messages.forEach((m, i) => {
    if (!(m instanceof HumanMessage) || !Array.isArray(m.content)) return;
    for (const part of m.content) {
      if (isFilePart(part) && part.mime_type === "application/pdf") {
        out.push({ messageIndex: i, filePart: part });
      }
    }
  });
  return out;
}

// ponytail: returns every kb_ref part across EVERY HumanMessage,
// deduped by docId (first occurrence wins). state.messages is
// append-only under the LangGraph addMessages reducer, so a kb_ref
// appended by kbAgent in turn N stays in Human(N) for the rest of
// the thread — even after the user has sent several more turns of
// plain text. Used by resolveKbRefs to feed the LLM the full history.
export function collectKbRefs(messages: BaseMessage[]): KbRefPart[] {
  const seen = new Set<string>();
  const out: KbRefPart[] = [];
  for (const m of messages) {
    if (!(m instanceof HumanMessage) || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (isKbRefPart(part) && !seen.has(part.docId)) {
        seen.add(part.docId);
        out.push(part);
      }
    }
  }
  return out;
}
