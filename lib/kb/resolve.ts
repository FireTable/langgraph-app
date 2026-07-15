import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { collectKbRefs, isKbRefPart } from "./extract";
import { getKbDocForResolve } from "./cache";

// ponytail: kb_ref → resolved text. Called from trimMessagesForInvoke
// at LLM-invoke time (state.messages carries the kb_ref part as-is).
// Replaces kb_ref parts on EVERY HumanMessage with a text part
// containing either the concatenated chunks or a status placeholder —
// never modifies state at rest.
//
// state.messages is append-only under the LangGraph addMessages
// reducer, so a kb_ref from an earlier turn can sit in an earlier
// HumanMessage while the current turn's HumanMessage has plain text.
// The earlier fix only touched the LAST HumanMessage, which silently
// dropped prior-turn doc content from the model's view.
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
      // ponytail: data-integrity guard. kbAgent writes chunks before
      // flipping status=success, so this branch is normally unreachable
      // — but a manual SQL edit, a backfill script, or a future
      // reprocess path could leave a success row with no chunks.
      // Returning "" would silently drop the doc context for the model;
      // [Processing...] is the closest existing placeholder ("the doc
      // is being prepared, ask again in a moment") which preserves the
      // trace.
      if (chunks.length === 0) return PLACEHOLDER_PROCESSING;
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

  const refs = collectKbRefs(messages);
  if (refs.length === 0) return messages;

  // ponytail: dedupe by docId (collectKbRefs already did) then resolve
  // in parallel. LRU cache on getKbDocForResolve makes back-to-back
  // resolves cheap, but parallel still saves wall-clock on the cold
  // path (a thread with 3 docs and 2 of them uncached).
  const uniqueDocIds = Array.from(new Set(refs.map((r) => r.docId)));
  const resolvedEntries = await Promise.all(
    uniqueDocIds.map(
      async (docId): Promise<[string, string | null]> => [docId, await resolveKbRef(docId, userId)],
    ),
  );
  const resolved = new Map<string, string | null>(resolvedEntries);

  return messages.map((m): BaseMessage => {
    if (!(m instanceof HumanMessage) || !Array.isArray(m.content)) return m;
    // ponytail: early-out if this message has no kb_ref — keeps the
    // happy path reference-equal and avoids needless new HumanMessage
    // allocations on the checkpointer write-back path.
    if (!m.content.some((p) => isKbRefPart(p))) return m;

    const newContent: unknown[] = [];
    let replaced = false;
    for (const part of m.content) {
      if (isKbRefPart(part)) {
        const text = resolved.get(part.docId);
        if (text === undefined) {
          // unknown docId — collectKbRefs sourced this so it shouldn't
          // happen; leave the part as-is rather than crash.
          newContent.push(part);
          continue;
        }
        if (text === null) {
          // doc not found (404 / cross-user) → drop the kb_ref part.
          replaced = true;
          continue;
        }
        newContent.push({ type: "text", text });
        replaced = true;
      } else {
        newContent.push(part);
      }
    }
    if (!replaced) return m;
    // ponytail: preserve id so the LangGraph addMessages reducer's
    // dedup-replace treats this as the same message, not a new one.
    return new HumanMessage({ content: newContent as never, id: m.id });
  });
}
