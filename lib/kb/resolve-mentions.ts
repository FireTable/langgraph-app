import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { eq, inArray, or } from "drizzle-orm";

import { db } from "@/db/client";
import { kbChunk, kbDocument, kbFolder } from "@/lib/kb/schema";
import { getKbEnv } from "@/lib/kb/env";
import { type HybridSearchResult } from "@/lib/kb/search";

// ponytail: @-mention resolver (issue #13 v3). The composer renders
// `:kb-document[label]{name=id}` (per-doc) or `:kb-folder[label]{name=id}`
// (per-folder, expands to every success doc inside) directive tokens via
// assistant-ui's `unstable_useMentionAdapter` +
// `unstable_defaultDirectiveFormatter`. The directive is preserved through
// the SDK wire and lands in the HumanMessage.content as a plain string.
//
// This module walks every HumanMessage, finds every directive, resolves
// each id against kb_document / kb_folder (per-user scoped), pre-fetches
// top-K chunks for `success` docs via direct SQL by document_id (titles
// don't tokenize, so relevance queries return [] for many KB docs), and
// emits a single `<mentioned-documents>` SystemMessage block. Soft-gates
// non-`success` docs with a warning line; unknown / cross-user ids are
// silently dropped.
//
// Total token budget (KB_MENTION_TOKEN_BUDGET) is split across mentions
// — each mention's topK is rebudgeted as
// ceil(BUDGET / (CHUNK_MAX_CHARS / 4 * mentionCount)).

// aUI's default directive syntax is `:type[label]{name=id}`. id is the
// canonical mention id (kb_document.id / kb_folder.id) — we extract it
// from `{name=…}`; if the brace group is missing (label === id), the
// inner capture is undefined and we fall back to the label. Same regex
// as @assistant-ui/core's `unstable_defaultDirectiveFormatter.DIRECTIVE_RE`
// (`/^:([\w-]{1,64})\[([^\]\n]{1,1024})\](?:\{name=([^}\n]{1,1024})\})?/u`)
// — we run a global match so one message can carry multiple mentions.
const MENTION_REGEX = /:([\w-]{1,64})\[([^\]\n]{1,1024})\](?:\{name=([^}\n]{1,1024})\})?/g;

function mentionIdFromMatch(match: RegExpExecArray): string | null {
  const explicit = match[3];
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const label = match[2];
  if (typeof label === "string" && label.length > 0) return label;
  return null;
}

export type MentionResolution =
  | { docId: string; kind: "resolved"; chunks: HybridSearchResult[]; sourceFolderId?: string }
  | { docId: string; kind: "soft-warning"; message: string; sourceFolderId?: string }
  | { docId: string; kind: "not-found"; sourceFolderId?: string };

export type MentionExtraction = {
  // Doc-level mentions (`:kb-document[id]`).
  docIds: string[];
  // Folder-level mentions (`:kb-folder[id]`) — expanded into doc ids at
  // resolve time, but kept separate so the system block can label which
  // folder each doc came from.
  folderIds: string[];
};

function extractMentions(content: unknown): MentionExtraction {
  const out: MentionExtraction = { docIds: [], folderIds: [] };
  const scan = (s: string) => {
    for (const m of s.matchAll(MENTION_REGEX)) {
      const id = mentionIdFromMatch(m);
      if (!id) continue;
      const type = m[1];
      if (type === "kb-document" || type === "kb-doc") out.docIds.push(id);
      else if (type === "kb-folder") out.folderIds.push(id);
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

function perMentionTopK(mentionCount: number): number {
  const env = getKbEnv();
  const tokensPerChunk = Math.ceil(env.chunkMaxChars / 4);
  const perMention = Math.ceil(env.mentionTokenBudget / (tokensPerChunk * mentionCount));
  return Math.min(env.mentionTopKMax, Math.max(1, Math.min(env.mentionTopKDefault, perMention)));
}

type ResolvedDoc = {
  docId: string;
  title: string;
  status: string;
  folderId: string;
};

type FolderRow = { id: string; name: string };

// ponytail: a single bulk SQL round-trip per table keeps the resolver
// at O(1) queries regardless of mention count. Each mention still goes
// through the chunk-fetch loop (we want topK chunks PER doc so the LLM
// has balanced context), but the doc/folder existence checks are batched.
async function lookupDocs(userId: string, docIds: string[]): Promise<Map<string, ResolvedDoc>> {
  if (docIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: kbDocument.id,
      title: kbDocument.title,
      status: kbDocument.status,
      folderId: kbDocument.folderId,
    })
    .from(kbDocument)
    .where(eq(kbDocument.userId, userId));
  // ponytail: filter via inArray on the JS side — `kb_document.id` is a
  // text PK; IN-list query works either way but doing it post-load keeps
  // the userId scoping the canonical filter.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, ResolvedDoc>();
  for (const id of docIds) {
    const row = byId.get(id) ?? rows.find((r) => r.title === id);
    if (row)
      out.set(id, { docId: row.id, title: row.title, status: row.status, folderId: row.folderId });
  }
  return out;
}

async function lookupFolders(userId: string, folderIds: string[]): Promise<Map<string, FolderRow>> {
  if (folderIds.length === 0) return new Map();
  const rows = await db
    .select({ id: kbFolder.id, name: kbFolder.name })
    .from(kbFolder)
    .where(eq(kbFolder.userId, userId));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, FolderRow>();
  for (const id of folderIds) {
    const row = byId.get(id) ?? rows.find((r) => r.name === id);
    if (row) out.set(id, { id: row.id, name: row.name });
  }
  return out;
}

async function docsInFolders(
  userId: string,
  folderIds: string[],
): Promise<Map<string, ResolvedDoc[]>> {
  if (folderIds.length === 0) return new Map();
  const folders = await db
    .select({ id: kbFolder.id, name: kbFolder.name })
    .from(kbFolder)
    .where(eq(kbFolder.userId, userId));

  const uuidToKey = new Map<string, string>();
  for (const f of folders) {
    if (folderIds.includes(f.id)) {
      uuidToKey.set(f.id, f.id);
    } else if (folderIds.includes(f.name)) {
      uuidToKey.set(f.id, f.name);
    }
  }

  const rows = await db
    .select({
      id: kbDocument.id,
      title: kbDocument.title,
      status: kbDocument.status,
      folderId: kbDocument.folderId,
    })
    .from(kbDocument)
    .where(eq(kbDocument.userId, userId));
  const out = new Map<string, ResolvedDoc[]>();
  for (const fid of folderIds) out.set(fid, []);
  for (const r of rows) {
    const key = uuidToKey.get(r.folderId);
    if (!key || !out.has(key)) continue;
    out.get(key)!.push({
      docId: r.id,
      title: r.title,
      status: r.status,
      folderId: r.folderId,
    });
  }
  return out;
}

async function fetchChunksForDocs(
  docIds: string[],
  topK: number,
  chunkMaxChars: number,
): Promise<Map<string, HybridSearchResult[]>> {
  const out = new Map<string, HybridSearchResult[]>();
  if (docIds.length === 0) return out;

  const uuids = docIds.filter((id) => id.startsWith("d-"));
  const titles = docIds.filter((id) => !id.startsWith("d-"));

  const conditions = [];
  if (uuids.length > 0) conditions.push(inArray(kbChunk.documentId, uuids));
  if (titles.length > 0) conditions.push(inArray(kbDocument.title, titles));

  if (conditions.length === 0) return out;

  const rows = await db
    .select({
      chunkId: kbChunk.id,
      documentId: kbChunk.documentId,
      docTitle: kbDocument.title,
      content: kbChunk.content,
    })
    .from(kbChunk)
    .innerJoin(kbDocument, eq(kbChunk.documentId, kbDocument.id))
    .where(or(...conditions))
    .orderBy(kbChunk.documentId, kbChunk.ordinal);
  const perDoc = new Map<string, HybridSearchResult[]>();
  for (const r of rows) {
    const key = docIds.find((id) => id === r.documentId || id === r.docTitle);
    if (!key) continue;
    const list = perDoc.get(key) ?? [];
    if (list.length < topK) {
      list.push({
        chunkId: r.chunkId,
        documentId: r.documentId,
        docTitle: r.docTitle,
        pageNumbers: [],
        content: r.content.slice(0, chunkMaxChars),
        rrfScore: 1.0,
        legsHit: ["kw"],
      });
      perDoc.set(key, list);
    }
  }
  for (const [key, list] of perDoc) out.set(key, list);
  return out;
}

export async function resolveKbMentions(
  messages: BaseMessage[],
  userId: string | undefined,
): Promise<BaseMessage[]> {
  // ponytail: no userId → can't resolve cross-user safety. The
  // composer doesn't surface mentions without a session.
  if (!userId) return messages;

  const { docIds: rawDocIds, folderIds: rawFolderIds } = (() => {
    const docIds: string[] = [];
    const folderIds: string[] = [];
    for (const m of messages) {
      if (!(m instanceof HumanMessage)) continue;
      const ex = extractMentions(m.content);
      docIds.push(...ex.docIds);
      folderIds.push(...ex.folderIds);
    }
    return { docIds, folderIds };
  })();

  const docIdSet = new Set(rawDocIds);
  const folderIdSet = new Set(rawFolderIds);

  if (docIdSet.size === 0 && folderIdSet.size === 0) return messages;

  const env = getKbEnv();
  // ponytail: per-mention budget — count distinct doc-level mentions
  // AND expanded folder docs (a folder with N docs counts as N mentions
  // for budgeting; otherwise a folder with 50 docs would exhaust the
  // token budget in one shot). We compute the count after folder
  // expansion below; the first pass uses docIdSet.size + rawFolderIds
  // to get a coarse upper bound for the doc-only path.
  const initialUpperBound = docIdSet.size + rawFolderIds.length;
  const folderById = await lookupFolders(userId, [...folderIdSet]);
  const docsByFolder = await docsInFolders(userId, [...folderIdSet]);

  // Expand folders → docs. Track which docs came from a folder so we
  // can label the system block with the folder name.
  const docsFromFolders: Array<{
    docId: string;
    folderId: string;
    folderName: string;
    title: string;
  }> = [];
  const droppedFolderResolutions: MentionResolution[] = [];

  for (const folderId of folderIdSet) {
    const folder = folderById.get(folderId);
    if (!folder) {
      droppedFolderResolutions.push({ docId: folderId, kind: "not-found" });
      continue;
    }
    const docs = docsByFolder.get(folderId) ?? [];
    const successDocs = docs.filter((d) => d.status === "success");
    const pendingOrFailed = docs.filter((d) => d.status !== "success");
    if (docs.length === 0) {
      droppedFolderResolutions.push({
        docId: folderId,
        kind: "soft-warning",
        message: `[folder "${folder.name}" is empty]`,
      });
      continue;
    }
    if (successDocs.length === 0) {
      const sample = pendingOrFailed[0]!;
      droppedFolderResolutions.push({
        docId: folderId,
        kind: "soft-warning",
        message:
          sample.status === "parsing"
            ? `[folder "${folder.name}" — all docs still ingesting]`
            : sample.status === "failed"
              ? `[folder "${folder.name}" — all docs failed ingestion]`
              : `[folder "${folder.name}" — no ready docs (status: ${sample.status})]`,
      });
      continue;
    }
    for (const d of successDocs) {
      // Skip if a doc-level mention also references this doc — explicit
      // doc mention wins for labeling.
      if (docIdSet.has(d.docId)) continue;
      docIdSet.add(d.docId);
      docsFromFolders.push({ docId: d.docId, folderId, folderName: folder.name, title: d.title });
    }
    // ponytail: surface per-folder soft-warnings for any non-success
    // docs the folder expansion skipped. A folder with 5 success + 2
    // failed docs should still tell the user "2 docs in this folder
    // couldn't be ingested" — the per-doc soft-warning only fires for
    // explicit :kb-document[id] mentions, not for folder expansions.
    for (const d of pendingOrFailed) {
      const message =
        d.status === "parsing"
          ? `[doc "${d.title}" in folder "${folder.name}" still ingesting]`
          : d.status === "failed"
            ? `[doc "${d.title}" in folder "${folder.name}" failed ingestion]`
            : `[doc "${d.title}" in folder "${folder.name}" not yet ready (status: ${d.status})]`;
      droppedFolderResolutions.push({ docId: d.docId, kind: "soft-warning", message });
    }
  }

  // ponytail: fetch all docs in one round-trip now that we know the
  // full id set (direct mentions + folder-expanded). This is what the
  // block-rendering path needs for doc titles.
  const docById = await lookupDocs(userId, [...docIdSet]);
  // Backfill titles for folder-expanded docs that aren't in the lookup
  // (defensive — lookupDocs should have caught them since userId scoping
  // matches, but a future schema drift would otherwise render "(unknown)").
  for (const d of docsFromFolders) {
    if (!docById.has(d.docId)) {
      docById.set(d.docId, {
        docId: d.docId,
        title: d.title,
        status: "success",
        folderId: d.folderId,
      });
    }
  }

  const mentionCount = Math.max(initialUpperBound, docIdSet.size);
  const topK = perMentionTopK(mentionCount);

  // Build resolutions for doc-level mentions (in their original order).
  const resolutions: MentionResolution[] = [...droppedFolderResolutions];
  for (const id of rawDocIds) {
    const doc = docById.get(id);
    if (!doc) {
      resolutions.push({ docId: id, kind: "not-found" });
      continue;
    }
    if (doc.status !== "success") {
      const message =
        doc.status === "parsing"
          ? `[doc "${doc.title}" still ingesting — will appear when KB ingest finishes]`
          : doc.status === "failed"
            ? `[doc "${doc.title}" failed ingestion — content unavailable]`
            : `[doc "${doc.title}" not yet ready (status: ${doc.status})]`;
      resolutions.push({ docId: id, kind: "soft-warning", message });
      continue;
    }
    // placeholder; chunks filled after the bulk fetch
    resolutions.push({ docId: id, kind: "resolved", chunks: [] });
  }
  // Plus folder-expanded docs (in folder order). Skip if a direct doc
  // mention already produced a resolution for the same id.
  for (const { docId, folderId } of docsFromFolders) {
    if (resolutions.some((r) => r.docId === docId && r.kind === "resolved")) continue;
    resolutions.push({ docId, kind: "resolved", chunks: [], sourceFolderId: folderId });
  }

  // Bulk-fetch chunks for every resolved doc in one query.
  const resolvedIds = resolutions.filter((r) => r.kind === "resolved").map((r) => r.docId);
  const chunksByDoc = await fetchChunksForDocs(resolvedIds, topK, env.chunkMaxChars);
  for (const r of resolutions) {
    if (r.kind === "resolved") r.chunks = chunksByDoc.get(r.docId) ?? [];
  }

  const hasResolved = resolutions.some((r) => r.kind === "resolved" && r.chunks.length > 0);
  const softWarnings = resolutions
    .filter(
      (r): r is Extract<MentionResolution, { kind: "soft-warning" }> => r.kind === "soft-warning",
    )
    .map((r) => r.message);

  // ponytail: don't inject a ToolMessage if there's nothing useful to
  // surface (no resolved chunks + no warnings). Caller gets the original
  // messages back unchanged. Router / sub-agents see no extra noise.
  if (!hasResolved && softWarnings.length === 0) return messages;

  // ponytail: render the section. Each doc gets its own header
  // (`## "doc title"`). If the doc came from a folder mention, prepend
  // the folder name as context so the LLM knows which folder the user
  // pulled from.
  const folderNameById = new Map<string, string>(
    docsFromFolders.map((d) => [d.docId, d.folderName]),
  );
  const blocks: string[] = [];
  for (const r of resolutions) {
    if (r.kind !== "resolved" || r.chunks.length === 0) continue;
    const doc = docById.get(r.docId);
    const title = doc?.title ?? "(unknown)";
    const folderLabel = folderNameById.get(r.docId);
    const header = folderLabel ? `## "${title}" (from folder "${folderLabel}")` : `## "${title}"`;
    const numbered = r.chunks.map((c, i) => `[${i + 1}] ${c.content}`).join("\n\n");
    blocks.push(`${header}\n${numbered}`);
  }

  const section = [
    "<mentioned-documents>",
    "The user mentioned the following knowledge-base documents in this turn.",
    "Use the chunks below as ground truth. Cite with the `[1] [2]` markers you see.",
    "",
    ...blocks,
    ...(softWarnings.length > 0 ? ["", "## Soft warnings", ...softWarnings] : []),
    "</mentioned-documents>",
  ].join("\n");

  // ponytail: de-dup. A previous prepareData pass may have already
  // injected a kb-context pair in this thread's state.messages (the
  // LangGraph messages reducer appends, so it persists across turns
  // until something explicitly drops it). Re-inserting with the same
  // `tool_call_id` would create a duplicate that strict LLM providers
  // (Anthropic, OpenAI) reject with "no tool call found for function
  // call output with call_id …". Skip the injection when we see an
  // existing one — the previously-injected context is still in scope
  // for the LLM, and the user's NEW directive text in the most
  // recent HumanMessage is enough for the LLM to call search_kb for
  // a fresh pull if the old chunks aren't enough.
  const toolCallId = "kb-context";
  if (messages.some((m) => m instanceof ToolMessage && m.tool_call_id === toolCallId)) {
    return messages;
  }

  // ponytail: payload matches the search_kb / search_graph ToolMessage
  // shape (`{ content, documents, empty }`) so the existing
  // KbSearchToolUI card picks it up via the same parseResult path —
  // no custom card needed. `content` is the LLM-facing markdown text
  // with `[1] [2]` markers; `documents` is the structured chunks for
  // the UI. JSON-stringified because ToolMessage content is a string.
  const toolResultPayload = JSON.stringify({
    content: section,
    documents: blocks.map((block, i) => {
      // ponytail: rebuild a per-chunk record that matches the
      // KbSearchDocument shape. The LLM-facing block has the doc
      // title and `[1]`-prefixed chunks; we split the title out and
      // re-attach the raw chunk content so the UI card can render
      // the chunk list with leg badges.
      const titleMatch = block.match(/^## "?([^"(]+?)"?(?:\s*\(from folder "[^"]+"\))?\n/);
      const title = titleMatch?.[1]?.trim() ?? "(unknown)";
      const chunkTexts = block
        .split("\n\n")
        .slice(1) // drop the ## header
        .map((s) => s.replace(/^\[\d+\]\s*/, ""));
      return {
        chunkId: `c-synthetic-${i}`,
        documentId: title,
        docTitle: title,
        pageNumbers: [],
        content: chunkTexts.join("\n\n"),
        rrfScore: 1.0,
        legsHit: ["kw"],
      };
    }),
    empty: false,
  });

  // ponytail: AIMessage + ToolMessage PAIR. LLM providers validate
  // tool_call_id pairing and reject a lone ToolMessage — the synthetic
  // call needs both halves. AIMessage has empty content + a
  // `tool_calls` entry whose `id` matches the ToolMessage's
  // `tool_call_id`. `args` mirrors search_kb's args so the existing
  // KbSearchToolUI card renders the right label.
  const toolArgs = {
    query: blocks
      .map((b) => b.match(/^## "?([^"(]+?)"?/)?.[1]?.trim() ?? "")
      .filter(Boolean)
      .join(", "),
    topK: env.hybridTopKDefault,
  };
  const assistantCall = new AIMessage({
    content: "",
    tool_calls: [
      {
        id: toolCallId,
        name: "kb_context_retrieval",
        args: toolArgs,
      },
    ],
  });
  const toolResult = new ToolMessage({
    content: toolResultPayload,
    tool_call_id: toolCallId,
    name: "kb_context_retrieval",
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
