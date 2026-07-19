import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { eq, inArray, or, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { kbChunk, kbDocument, kbFolder } from "@/lib/kb/schema";
import { getKbEnv } from "@/lib/kb/env";
import { type HybridSearchResult } from "@/lib/kb/search";

// ponytail: @-mention resolver (issue #13 v3). The composer renders
// `:kb-document[label]{id=id}` (per-doc) or `:kb-folder[label]{id=id}`
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

// aUI's default directive syntax is `:type[label]{id=id}`. id is the
// canonical mention id (kb_document.id / kb_folder.id) — we extract it
// from `{id=…}`; if the brace group is missing (label === id), the
// inner capture is undefined and we fall back to the label. Same regex
// as @assistant-ui/core's `unstable_defaultDirectiveFormatter.DIRECTIVE_RE`
// (`/^:([\w-]{1,64})\[([^\]\n]{1,1024})\](?:\{id=([^}\n]{1,1024})\})?/u`)
// — we run a global match so one message can carry multiple mentions.
const MENTION_REGEX = /:([\w-]{1,64})\[([^\]\n]{1,1024})\](?:\{id=([^}\n]{1,1024})\})?/g;

function mentionIdFromMatch(match: RegExpExecArray): string | null {
  const explicit = match[3];
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const label = match[2];
  if (typeof label === "string" && label.length > 0) return label;
  return null;
}

export type MentionResolution =
  | {
      docId: string;
      kind: "resolved";
      chunks: HybridSearchResult[];
      sourceFolderId?: string;
      mode?: "meta" | "full";
    }
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
      resolutions.push({ docId: doc.docId, kind: "soft-warning", message });
      continue;
    }
    resolutions.push({ docId: doc.docId, kind: "resolved", chunks: [] });
  }
  // Plus folder-expanded docs (in folder order). Skip if a direct doc
  // mention already produced a resolution for the same id.
  for (const { docId, folderId } of docsFromFolders) {
    if (resolutions.some((r) => r.docId === docId && r.kind === "resolved")) continue;
    resolutions.push({ docId, kind: "resolved", chunks: [], sourceFolderId: folderId });
  }

  // Pre-validate chunk counts for all successfully resolved docs in one batch
  const resolvedIds = resolutions.filter((r) => r.kind === "resolved").map((r) => r.docId);
  const chunkCountMap = new Map<string, number>();
  if (resolvedIds.length > 0) {
    const counts = await db
      .select({
        docId: kbChunk.documentId,
        count: sql<number>`count(*)::int`,
      })
      .from(kbChunk)
      .where(inArray(kbChunk.documentId, resolvedIds))
      .groupBy(kbChunk.documentId);
    for (const c of counts) {
      chunkCountMap.set(c.docId, c.count);
    }
  }

  // Assign resolution modes based on chunk count (Branch 1 vs Branch 2)
  for (const r of resolutions) {
    if (r.kind === "resolved") {
      const count = chunkCountMap.get(r.docId) ?? 0;
      r.mode = count > 0 ? "meta" : "full";
    }
  }

  // Fetch full page contents for Branch 2 (full fallback mode) documents
  const fallbackDocIds = resolutions
    .filter(
      (r): r is Extract<MentionResolution, { kind: "resolved" }> =>
        r.kind === "resolved" && r.mode === "full",
    )
    .map((r) => r.docId);

  const pagesByDoc = new Map<string, string>();
  if (fallbackDocIds.length > 0) {
    const fallbackDocs = await db
      .select({
        id: kbDocument.id,
        pages: kbDocument.pages,
      })
      .from(kbDocument)
      .where(inArray(kbDocument.id, fallbackDocIds));

    for (const d of fallbackDocs) {
      const pagesArray = (d.pages ?? []) as Array<{
        pageIndex?: number;
        pageNumber?: number;
        markdown?: string;
      }>;
      const sortedPages = [...pagesArray].sort((a, b) => {
        const aNum = a.pageNumber ?? a.pageIndex ?? 0;
        const bNum = b.pageNumber ?? b.pageIndex ?? 0;
        return aNum - bNum;
      });
      const fullText = sortedPages
        .map((p) => p.markdown ?? "")
        .filter(Boolean)
        .join("\n\n");
      pagesByDoc.set(d.id, fullText);
    }
  }

  const softWarnings = resolutions
    .filter(
      (r): r is Extract<MentionResolution, { kind: "soft-warning" }> => r.kind === "soft-warning",
    )
    .map((r) => r.message);

  // Group doc metadata representations by folder for the prompt block
  const docsByFolderGrouped = new Map<string, typeof docsFromFolders>();
  for (const d of docsFromFolders) {
    const list = docsByFolderGrouped.get(d.folderId) ?? [];
    list.push(d);
    docsByFolderGrouped.set(d.folderId, list);
  }

  const metaBlocks: string[] = [];
  for (const folderId of folderIdSet) {
    const folder = folderById.get(folderId);
    if (!folder) continue;
    const children = docsByFolderGrouped.get(folderId) ?? [];
    const metaChildren = children.filter((c) => {
      const r = resolutions.find((res) => res.docId === c.docId && res.kind === "resolved");
      return r?.kind === "resolved" && r.mode === "meta";
    });

    if (metaChildren.length > 0) {
      const childLines = metaChildren
        .map((c) => `    - Document: "${c.title}" (ID: "${c.docId}")`)
        .join("\n");
      metaBlocks.push(`- Folder: "${folder.name}" (ID: "${folder.id}") containing:\n${childLines}`);
    }
  }

  // Plus direct doc mentions that are in meta mode and not inside folder mentions
  for (const id of rawDocIds) {
    const doc = docById.get(id);
    if (doc?.status === "success") {
      const r = resolutions.find((res) => res.docId === doc.docId && res.kind === "resolved");
      if (r?.kind === "resolved" && r.mode === "meta") {
        const isFromFolder = docsFromFolders.some((df) => df.docId === doc.docId);
        if (!isFromFolder) {
          metaBlocks.push(`- Document: "${doc.title}" (ID: "${doc.docId}")`);
        }
      }
    }
  }

  // Build Full content representations (Branch 2)
  const folderNameById = new Map<string, string>(
    docsFromFolders.map((d) => [d.docId, d.folderName]),
  );
  const fallbackBlocks: string[] = [];
  for (const r of resolutions) {
    if (r.kind === "resolved" && r.mode === "full") {
      const doc = docById.get(r.docId);
      const title = doc?.title ?? "(unknown)";
      const folderLabel = folderNameById.get(r.docId);
      const header = folderLabel
        ? `## "${title}" (from folder "${folderLabel}") [Fallback: Full Content]`
        : `## "${title}" [Fallback: Full Content]`;
      const content = pagesByDoc.get(r.docId) ?? "";
      fallbackBlocks.push(`${header}\n${content}`);
    }
  }

  // Build UI Payload documents list
  const documentsPayload: any[] = [];

  // For meta-mode doc mentions (including folder children and direct mentions)
  for (const id of docIdSet) {
    const doc = docById.get(id);
    if (doc?.status === "success") {
      const r = resolutions.find((res) => res.docId === doc.docId && res.kind === "resolved");
      if (r?.kind === "resolved" && r.mode === "meta") {
        documentsPayload.push({
          chunkId: `meta-${doc.docId}`,
          documentId: doc.docId,
          docTitle: doc.title,
          pageNumbers: [],
          content: `Document loaded. The model will query its content as needed via search_kb.`,
          rrfScore: 1.0,
          legsHit: ["mention"],
        });
      }
    }
  }

  // For full-mode doc mentions
  for (const r of resolutions) {
    if (r.kind === "resolved" && r.mode === "full") {
      const doc = docById.get(r.docId);
      if (doc) {
        documentsPayload.push({
          chunkId: `full-${doc.docId}`,
          documentId: doc.docId,
          docTitle: doc.title,
          pageNumbers: [],
          content: pagesByDoc.get(doc.docId) ?? "",
          rrfScore: 1.0,
          legsHit: ["full"],
        });
      }
    }
  }

  const hasResolved = documentsPayload.length > 0;
  if (!hasResolved && softWarnings.length === 0) return messages;

  const sectionParts = [
    "<mentioned-documents>",
    "The user mentioned knowledge-base documents/folders in this turn.",
  ];

  if (metaBlocks.length > 0) {
    sectionParts.push(
      "The following sources are available for search. You MUST call the `search_kb` tool with `documentId` or `folderId` filters to search their contents. DO NOT answer from pre-trained knowledge if retrieval from these sources is possible.",
      "",
      ...metaBlocks,
      "",
    );
  }

  if (fallbackBlocks.length > 0) {
    sectionParts.push(
      "The following sources had no chunk index yet, so their full page contents are provided below. Use this content directly to answer:",
      "",
      ...fallbackBlocks,
      "",
    );
  }

  if (softWarnings.length > 0) {
    sectionParts.push("## Soft warnings", ...softWarnings);
  }

  sectionParts.push("</mentioned-documents>");
  const section = sectionParts.join("\n");

  const toolCallId = "kb-context";
  if (messages.some((m) => m instanceof ToolMessage && m.tool_call_id === toolCallId)) {
    return messages;
  }

  const toolResultPayload = JSON.stringify({
    content: section,
    documents: documentsPayload,
    empty: false,
  });

  const queryParts: string[] = [];
  for (const fid of rawFolderIds) {
    const f = folderById.get(fid);
    if (f) queryParts.push(`@${f.name}`);
  }
  for (const id of rawDocIds) {
    const d = docById.get(id);
    if (d) queryParts.push(`@${d.title}`);
  }
  const toolArgs = {
    query: queryParts.join(", "),
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
