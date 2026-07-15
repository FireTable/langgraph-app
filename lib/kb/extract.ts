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

export function findLastHumanMessage(messages: BaseMessage[]): HumanMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m instanceof HumanMessage) return m;
  }
  return null;
}

export function getLastHumanContent(messages: BaseMessage[]): unknown[] | null {
  const last = findLastHumanMessage(messages);
  if (!last || !Array.isArray(last.content)) return null;
  return last.content;
}

export function extractFilePart(messages: BaseMessage[]): FilePart | null {
  const content = getLastHumanContent(messages);
  if (!content) return null;
  for (const part of content) {
    if (isFilePart(part)) return part;
  }
  return null;
}

export function extractKbRef(messages: BaseMessage[]): KbRefPart | null {
  const content = getLastHumanContent(messages);
  if (!content) return null;
  for (const part of content) {
    if (isKbRefPart(part)) return part;
  }
  return null;
}

// ponytail: returns EVERY PDF file part from EVERY HumanMessage in
// message order. kbAgent uses this to discover what needs OCR — it
// must NOT be last-only, since the router can route to kbAgent while
// earlier HumanMessages still carry unresolved PDFs (e.g. when state
// is replayed or simulated). The single-PDF extraction lives in
// extractFilePart (last-only, current-turn only) and stays unchanged.
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
// plain text. The router still uses extractKbRef (last-only) to flag
// the current turn; this is the multi-message equivalent for the
// resolve layer.
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

// ponytail: kbAgent appends a kb_ref part to the same HumanMessage
// that carried the original file part. To keep reducer dedup-replace
// stable, we must preserve the message id when rewriting. This helper
// produces the rewritten message array WITHOUT mutating the input —
// callers spread it back into state.messages.
//
// Drops the original file part; preserves the text parts and any
// existing kb_ref parts (except ours — id-keyed dedup covers that).
export function appendKbRef(
  messages: BaseMessage[],
  docId: string,
  attachmentId?: string,
): BaseMessage[] {
  const last = findLastHumanMessage(messages);
  if (!last || !Array.isArray(last.content)) return messages;
  const newPart: KbRefPart = { type: "kb_ref", docId, attachmentId };
  const newContent = [...last.content.filter((p) => !isFilePart(p) && !isKbRefPart(p)), newPart];
  // ponytail: HumanMessage constructor takes id as second arg; passing
  // it explicitly keeps the reducer's addMessages dedup-replace path.
  const rewritten = new HumanMessage({
    content: newContent,
    id: last.id,
  });
  return [
    ...messages.slice(0, messages.indexOf(last)),
    rewritten,
    ...messages.slice(messages.indexOf(last) + 1),
  ];
}
