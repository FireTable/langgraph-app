import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { eq, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import { kbChunk, kbDocument } from "@/lib/kb/schema";

// ponytail: @-mention resolver (issue #13 v3) — minimal scope.
//
// The composer renders `:kb-document[label]{id=id}` directive tokens
// via assistant-ui's `unstable_useMentionAdapter` +
// `unstable_defaultDirectiveFormatter`. The directive is preserved
// through the SDK wire and lands in the HumanMessage.content as a
// plain string. From there the LLM is responsible for actually
// calling `search_kb(documentId=…)` / `search_kb(folderId=…)` — the
// system prompt already teaches it the right pattern.
//
// The resolver only intervenes for ONE case: a `@doc` mention whose
// status is `success` but the chunk index is empty (the OCR finished
// but the chunking pass didn't land any rows). `search_kb` can't
// help there — there's nothing to retrieve — so the resolver
// pre-loads the joined page markdown and injects it as a synthetic
// `search_kb` ToolMessage. The chat card renders it via the
// existing toolkit entry (legsHit: ["full"], docTitle + content).
//
// Everything else (success docs with chunks, folder mentions,
// non-success statuses, unknown ids) is dropped silently. The LLM
// reads the directive from the HumanMessage text and handles it.

// aUI's default directive syntax is `:type[label]{id=id}`. id is the
// canonical mention id (kb_document.id) — we extract it from
// `{id=…}`; if the brace group is missing (label === id), we fall
// back to the label. Same regex as @assistant-ui/core's
// `unstable_defaultDirectiveFormatter.DIRECTIVE_RE` — we run a
// global match so one message can carry multiple mentions.
const MENTION_REGEX = /:([\w-]{1,64})\[([^\]\n]{1,1024})\](?:\{id=([^}\n]{1,1024})\})?/g;

const FALLBACK_TOOL_CALL_ID = "kb-fallback";

export type MentionExtraction = {
  // Doc-level mentions (`:kb-document[id]`). Folder mentions are
  // intentionally NOT resolved here — the LLM handles them via
  // search_kb(folderId=…).
  docIds: string[];
};

function extractMentions(content: unknown): MentionExtraction {
  const out: MentionExtraction = { docIds: [] };
  const scan = (s: string) => {
    for (const m of s.matchAll(MENTION_REGEX)) {
      const id = mentionIdFromMatch(m);
      if (!id) continue;
      const type = m[1];
      if (type === "kb-document" || type === "kb-doc") out.docIds.push(id);
    }
  };
  if (typeof content === "string") scan(content);
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
        scan(part.text);
      }
    }
  }
  return out;
}

function mentionIdFromMatch(match: RegExpExecArray): string | null {
  const explicit = match[3];
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const label = match[2];
  if (typeof label === "string" && label.length > 0) return label;
  return null;
}

type ResolvedDoc = {
  docId: string;
  title: string;
  status: string;
};

async function lookupDocs(userId: string, docIds: string[]): Promise<Map<string, ResolvedDoc>> {
  if (docIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: kbDocument.id,
      title: kbDocument.title,
      status: kbDocument.status,
    })
    .from(kbDocument)
    .where(eq(kbDocument.userId, userId));
  // ponytail: filter via inArray on the JS side — `kb_document.id` is a
  // text PK; IN-list query works either way but doing it post-load keeps
  // the userId scoping the canonical filter. The same lookup also
  // accepts a title (`:kb-doc[title.pdf]`) since the directive regex
  // falls back to the label when no `{id=…}` group is present.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, ResolvedDoc>();
  for (const id of docIds) {
    const row = byId.get(id) ?? rows.find((r) => r.title === id);
    if (row) out.set(id, { docId: row.id, title: row.title, status: row.status });
  }
  return out;
}

export async function resolveKbMentions(
  messages: BaseMessage[],
  userId: string | undefined,
): Promise<BaseMessage[]> {
  // ponytail: no userId → can't resolve cross-user safety. The
  // composer doesn't surface mentions without a session.
  if (!userId) return messages;

  // 1. Extract doc-level mentions from every HumanMessage.
  const rawDocIds: string[] = [];
  for (const m of messages) {
    if (!(m instanceof HumanMessage)) continue;
    rawDocIds.push(...extractMentions(m.content).docIds);
  }
  if (rawDocIds.length === 0) return messages;

  // 2. Look up the docs (per-user scoped). Cross-user / unknown ids
  // are silently dropped — same convention as /api/threads.
  const docById = await lookupDocs(userId, [...new Set(rawDocIds)]);

  // 3. Find docs that are success + 0 chunks — the only case we
  // intervene on. Everything else (chunks > 0, parsing, failed,
  // unknown) is left to the LLM via search_kb.
  const successNoChunkIds: string[] = [];
  for (const id of rawDocIds) {
    const doc = docById.get(id);
    if (!doc) continue;
    if (doc.status !== "success") continue;
    successNoChunkIds.push(doc.docId);
  }
  if (successNoChunkIds.length === 0) return messages;

  // ponytail: dedup by docId — a mention appearing twice in the same
  // message (e.g. :kb-doc[x]…:kb-doc[x]) should produce one chunk-count
  // check, not two.
  const uniqueSuccessIds = [...new Set(successNoChunkIds)];
  const counts = await db
    .select({ documentId: kbChunk.documentId, count: db.$count(kbChunk) })
    .from(kbChunk)
    .where(inArray(kbChunk.documentId, uniqueSuccessIds))
    .groupBy(kbChunk.documentId);
  const countMap = new Map(counts.map((c) => [c.documentId, Number(c.count)]));
  const fallbackIds = uniqueSuccessIds.filter((id) => (countMap.get(id) ?? 0) === 0);
  if (fallbackIds.length === 0) return messages;

  // 4. Dedup against an already-injected fallback (e.g. a re-run of
  // the resolver on the same turn). The tool_call_id is the canonical
  // key — LLM providers validate that every tool_call_id has exactly
  // one ToolMessage, so re-injecting would error.
  const alreadyInjected = messages.some(
    (m) => m instanceof ToolMessage && m.tool_call_id === FALLBACK_TOOL_CALL_ID,
  );
  if (alreadyInjected) return messages;

  // 5. Fetch the joined page markdown for the fallback docs.
  const rows = await db
    .select({ id: kbDocument.id, title: kbDocument.title, pages: kbDocument.pages })
    .from(kbDocument)
    .where(inArray(kbDocument.id, fallbackIds));
  const documentsPayload = rows.map((d) => {
    const pages = (d.pages ?? []) as Array<{
      pageIndex?: number;
      pageNumber?: number;
      markdown?: string;
    }>;
    const sorted = [...pages].sort((a, b) => {
      const an = a.pageNumber ?? a.pageIndex ?? 0;
      const bn = b.pageNumber ?? b.pageIndex ?? 0;
      return an - bn;
    });
    const fullText = sorted
      .map((p) => p.markdown ?? "")
      .filter(Boolean)
      .join("\n\n");
    return {
      chunkId: `full-${d.id}`,
      documentId: d.id,
      docTitle: d.title,
      pageNumbers: [],
      content: fullText,
      rrfScore: 1.0,
      legsHit: ["full"],
    };
  });
  const toolResultPayload = JSON.stringify({
    content:
      "Full document content for the KB source(s) below (chunk index unavailable; pages shown verbatim).",
    documents: documentsPayload,
    empty: false,
  });

  // 6. Inject the synthetic AIMessage+ToolMessage pair after the last
  // HumanMessage. The AIMessage's tool_args is empty — we don't know
  // the user's question here, and the LLM doesn't need it (the
  // ToolMessage content is the actual content to reason over).
  const assistantCall = new AIMessage({
    content: "",
    tool_calls: [
      {
        id: FALLBACK_TOOL_CALL_ID,
        name: "search_kb",
        args: {},
      },
    ],
  });
  const toolResult = new ToolMessage({
    content: toolResultPayload,
    tool_call_id: FALLBACK_TOOL_CALL_ID,
    name: "search_kb",
  });

  const lastHumanIdx = messages.findLastIndex((m) => m instanceof HumanMessage);
  const result = [...messages];
  if (lastHumanIdx >= 0) {
    result.splice(lastHumanIdx + 1, 0, assistantCall, toolResult);
  } else {
    result.push(assistantCall, toolResult);
  }
  return result;
}

export const KB_FALLBACK_TOOL_CALL_ID = FALLBACK_TOOL_CALL_ID;
