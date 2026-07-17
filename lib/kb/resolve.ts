import { type BaseMessage, HumanMessage } from "@langchain/core/messages";
import { collectKbRefs, isFilePart } from "./extract";
import { getKbDocForResolve } from "./cache";

// ponytail: kb_ref → resolved text. Called from prepareMessagesForInvoke
// at LLM-invoke time (state.messages carries the kb_ref as-is).
// Replaces kb_ref-bearing parts on EVERY HumanMessage with a text part
// containing either the concatenated chunks or a status placeholder —
// never modifies state at rest.
//
// Two shapes carry a kb_ref today:
//  1. file part with `kb_ref: { docId, attachmentId? }` sibling
//     (canonical, new ingest path) — the file part itself gets
//     replaced with the resolved text; the sibling is dropped because
//     the docId is now inlined into the text.
//  2. legacy standalone `{ type: "kb_ref", docId }` part (older
//     threads) — kept for backward compat.
//
// The filename prefix `[kb:<docId>]` is NOT read here: backend has
// access to the canonical sibling and the sibling is the source of
// truth for the resolve layer. The prefix exists purely so the
// front-end (which loses the sibling through the SDK's
// `contentToParts` round-trip) can still recover the docId.
//
// state.messages is append-only under the LangGraph addMessages
// reducer, so a kb_ref from an earlier turn can sit in an earlier
// HumanMessage while the current turn's HumanMessage has plain text.
// "not found" returns null — caller drops the kb_ref entirely so the
// model never sees a stale id. Matches cross-user 404 semantics from
// docs/AUTH.md.

const PLACEHOLDER_PROCESSING = "[Processing...]";
const PLACEHOLDER_PENDING = "[Pending]";
function placeholderFailed(msg: string | null): string {
  return `[Failed: ${msg ?? "unknown error"}]`;
}

function readKbRefFromPart(part: unknown): { docId: string; attachmentId?: string } | null {
  if (isFilePart(part) && part.kb_ref && typeof part.kb_ref.docId === "string") {
    return part.kb_ref;
  }
  return null;
}

function hasKbRef(part: unknown): boolean {
  return readKbRefFromPart(part) !== null;
}

export async function resolveKbRef(docId: string, userId: string): Promise<string | null> {
  const entry = await getKbDocForResolve(userId, docId);
  if (!entry) return null;
  const { doc, chunks } = entry;
  switch (doc.status) {
    case "success":
      // ponytail: if pages array is populated with OCR results, join
      // them directly to reconstruct the full text. This avoids duplicate
      // chunks with overlapping segments and guarantees immediate context.
      if (Array.isArray(doc.pages) && doc.pages.length > 0) {
        return doc.pages
          .map((p) => (p as { markdown?: string }).markdown)
          .filter((m): m is string => typeof m === "string" && m.length > 0)
          .join("\n\n");
      }
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
    // allocations on the checkpointer write-back path. Check both
    // shapes: standalone kb_ref part AND file part with kb_ref sibling.
    if (!m.content.some(hasKbRef)) return m;

    const newContent: unknown[] = [];
    let replaced = false;
    for (const part of m.content) {
      const marker = readKbRefFromPart(part);
      if (!marker) {
        newContent.push(part);
        continue;
      }
      const text = resolved.get(marker.docId);
      if (text === undefined) {
        // unknown docId — collectKbRefs sourced this so it shouldn't
        // happen; leave the part as-is rather than crash.
        newContent.push(part);
        continue;
      }
      if (text === null) {
        // doc not found (404 / cross-user) → drop the kb_ref entirely.
        // For sibling-file, drop the whole file part; for standalone,
        // drop just the part.
        replaced = true;
        continue;
      }
      newContent.push({ type: "text", text });
      replaced = true;
    }
    if (!replaced) return m;
    // ponytail: preserve id so the LangGraph addMessages reducer's
    // dedup-replace treats this as the same message, not a new one.
    return new HumanMessage({ content: newContent as never, id: m.id });
  });
}
