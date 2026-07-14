import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { extractKbRef, isKbRefPart } from "./extract";
import { getKbDocForResolve } from "./cache";

// ponytail: kb_ref → resolved text. Called from trimMessagesForInvoke
// at LLM-invoke time (state.messages carries the kb_ref part as-is).
// Replaces ONLY the kb_ref part of the latest HumanMessage with a text
// part containing either the concatenated chunks or a status
// placeholder — never modifies state at rest.
//
// "not found" returns null — caller drops the kb_ref entirely so the
// model never sees a stale id. Matches cross-user 404 semantics from
// docs/AUTH.md.

const PLACEHOLDER_PROCESSING = "[Processing...]";
const PLACEHOLDER_PENDING = "[Pending]";
function placeholderFailed(msg: string | null): string {
  return `[Failed: ${msg ?? "unknown error"}]`;
}

export async function resolveKbRef(docId: string, userId: string): Promise<string | null> {
  const entry = await getKbDocForResolve(userId, docId);
  if (!entry) return null;
  const { doc, chunks } = entry;
  switch (doc.status) {
    case "success":
      return chunks.map((c) => c.content).join("\n\n");
    case "parsing":
      return PLACEHOLDER_PROCESSING;
    case "pending":
      return PLACEHOLDER_PENDING;
    case "failed":
      return placeholderFailed(doc.errorMessage);
    default:
      // exhaustiveness — Drizzle's enum forbids other values, but be loud.
      return null;
  }
}

export async function resolveKbRefs(
  messages: BaseMessage[],
  userId: string,
): Promise<BaseMessage[]> {
  if (!userId) return messages;
  const ref = extractKbRef(messages);
  if (!ref) return messages;
  const text = await resolveKbRef(ref.docId, userId);
  if (text === null) {
    return stripKbRef(messages, ref.docId);
  }
  return replaceKbRefWithText(messages, ref.docId, text);
}

function findLastHumanIndex(messages: BaseMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] instanceof HumanMessage) return i;
  }
  return -1;
}

function stripKbRef(messages: BaseMessage[], docId: string): BaseMessage[] {
  const idx = findLastHumanIndex(messages);
  if (idx === -1) return messages;
  const last = messages[idx];
  if (!Array.isArray(last.content)) return messages;
  const filtered = last.content.filter((p) => !(isKbRefPart(p) && p.docId === docId));
  if (filtered.length === last.content.length) return messages;
  // ponytail: cast at the HumanMessage boundary — `filtered` is a
  // ContentBlock[] shaped subset that langchain accepts at runtime.
  const rewritten = new HumanMessage({
    content: filtered as never,
    id: last.id,
  });
  return [...messages.slice(0, idx), rewritten, ...messages.slice(idx + 1)];
}

function replaceKbRefWithText(messages: BaseMessage[], docId: string, text: string): BaseMessage[] {
  const idx = findLastHumanIndex(messages);
  if (idx === -1) return messages;
  const last = messages[idx];
  if (!Array.isArray(last.content)) return messages;
  const newContent: unknown[] = [];
  let replaced = false;
  for (const p of last.content) {
    if (isKbRefPart(p) && p.docId === docId) {
      newContent.push({ type: "text", text });
      replaced = true;
    } else {
      newContent.push(p);
    }
  }
  if (!replaced) return messages;
  const rewritten = new HumanMessage({
    content: newContent as never,
    id: last.id,
  });
  return [...messages.slice(0, idx), rewritten, ...messages.slice(idx + 1)];
}
