import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import PQueue from "p-queue";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { getChatModel, getEmbeddingModel, getOcrModel } from "@/backend/model";
import { KB_OCR_PAGE_PROMPT } from "@/backend/prompt/system";
import { capturingHandler, creditTrackingHandler } from "@/backend/callbacks";
import { checkpointer, subgraphCheckpointerConfig } from "@/backend/checkpointer";
import { store } from "@/backend/store";
import { screenshotPdf } from "@/lib/kb/screenshot";
import {
  ensureDefaultKbFolder,
  findKbDocumentByContentHash,
  findKbDocumentByAttachmentId,
  insertKbChunks,
  insertKbDocument,
  updateKbDocumentStatus,
  withKbTx,
} from "@/lib/kb/queries";
import { findAttachmentByR2Key } from "@/lib/attachments/queries";
import { extractAllPdfParts, isFilePart, type FilePart } from "@/lib/kb/extract";
import { invalidateKbDoc } from "@/lib/kb/cache";
import { EMBEDDING_DIM } from "@/lib/kb/schema";
import { r2KeyFromPublicUrl, uploadKbImage, getR2PublicBaseUrl, getObject } from "@/lib/r2/client";

// ponytail: v3 KB ingest subgraph — per-doc state. Compiled once at
// module load, wired into agent.ts as `kbAgent`. Sits between
// RouterNode ("PDF → kbAgent") and the sub-agents.
//
// Flow:
//   START → screenshot → ocr → chunkEmbedStore → END
//
// Every PDF file part in EVERY HumanMessage gets one of three
// outcomes:
//   1. `kb_ref` sibling stamped onto the file part (success, dedup,
//      failed with a docId, or parsing). The file part is PRESERVED —
//      the sibling just marks it as ingested so the next router pass
//      skips re-processing. The resolve layer (lib/kb/resolve.ts)
//      replaces the file part with resolved text at LLM-invoke time.
//   2. file part stripped (unknown attachment, can't even dedup).
//   3. carried over as a non-PDF file (images etc. — preserved).
//
// After one kbAgent invocation there are zero UNSTAMPED PDF file
// parts left in state.messages — every PDF either carries a kb_ref
// sibling or has been stripped. extractAllPdfParts / hasUnprocessedPdf
// filter on `!p.kb_ref` so the second router pass won't re-dispatch
// kbAgent.

type PageResult = {
  pageIndex: number;
  imageUrl: string;
  markdown: string;
};
type ChunkSeed = { ordinal: number; content: string; entities: string[]; embedding: number[] };

// ponytail: per-file record. One entry per PDF file part found across
// every HumanMessage. Drives every node — screenshotNode fills it,
// ocrNode updates page markdown, chunkEmbedStoreNode writes DB rows
// and uses it to rewrite HumanMessages. filePart.data is the join key
// when matching back to the original HumanMessage content.
type ProcessedFile = {
  messageIndex: number;
  filePart: FilePart;
  docId: string | null;
  attachmentId: string | null;
  r2Key: string | null;
  title: string | null;
  contentHash: string | null;
  // "new" = docId freshly generated, needs OCR + chunk + insert.
  // "dedup" = existing docId, skip the heavy pipeline.
  // "failed" = OCR failed (or empty markdown); docId may or may not
  //            exist in DB — resolve layer shows [Failed: ...] for
  //            the file part's kb_ref sibling, or strips the file
  //            part entirely if no docId was ever written.
  // "unknown" = attachment row missing, no docId at all.
  pipelineStatus: "new" | "dedup" | "failed" | "unknown";
  errorMessage: string | null;
};

const ocrPageSchema = z.object({
  markdown: z
    .string()
    .describe(
      "Clean markdown extraction of this PDF page. " +
        "Preserve headings, lists, code blocks, tables, and inline formatting. " +
        "Return an empty string if the page is blank or contains only decorative images. " +
        "Output ONLY the markdown — no preamble, no commentary, no code fences.",
    ),
});

const KbAgentState = new StateSchema({
  // From parent — populated by RouterNode at invoke time.
  messages: z.array(z.custom<BaseMessage>()),
  userId: z.string().nullable().default(null),
  // Internal.
  pagesByDocId: z.record(z.string(), z.array(z.custom<PageResult>())).default({}),
  chunksByDocId: z.record(z.string(), z.array(z.custom<ChunkSeed>())).default({}),
  processedFiles: z.array(z.custom<ProcessedFile>()).default([]),
  status: z.enum(["pending", "parsing", "success", "failed"]).default("pending"),
  errorMessage: z.string().nullable().default(null),
});

// ponytail: derive the state shape once and reuse. mirrors
// chat-agent.ts's inline BaseMessage[] pattern.
type KbAgentStateShape = {
  messages: BaseMessage[];
  userId: string | null;
  pagesByDocId: Record<string, PageResult[]>;
  chunksByDocId: Record<string, ChunkSeed[]>;
  processedFiles: ProcessedFile[];
  status: "pending" | "parsing" | "success" | "failed";
  errorMessage: string | null;
};

function makeError(message: string): Partial<KbAgentStateShape> {
  return { status: "failed", errorMessage: message, processedFiles: [] };
}

const OCR_CONCURRENCY = 5;
const ENTITY_CONCURRENCY = 5;

async function screenshotNode(
  state: KbAgentStateShape,
  config?: { configurable?: { userId?: string } },
): Promise<Partial<KbAgentStateShape>> {
  const userId = config?.configurable?.userId ?? state.userId;
  if (!userId) return makeError("user not provided");

  const pdfs = extractAllPdfParts(state.messages);
  if (pdfs.length === 0) return makeError("no PDF file parts found");

  const base = getR2PublicBaseUrl();

  // ponytail: per-PDF processing runs in parallel — each PDF is
  // independent, failures isolated to one entry, and the LRU on
  // findKbDocumentByContentHash makes repeat lookups free within a
  // single invocation. try/catch keeps the whole pipeline moving if
  // one PDF errors out — the failure shows up as a "failed" entry
  // with no docId, kbAgent still stamps a kb_ref sibling or strips
  // the file part cleanly.
  const processed = await Promise.all(
    pdfs.map(async ({ messageIndex, filePart }): Promise<ProcessedFile> => {
      const r2Key = r2KeyFromPublicUrl(filePart.data, base);
      try {
        const attachment = await findAttachmentByR2Key(userId, r2Key);
        if (!attachment) {
          return {
            messageIndex,
            filePart,
            docId: null,
            attachmentId: null,
            r2Key,
            title: null,
            contentHash: null,
            pipelineStatus: "unknown",
            errorMessage: "attachment not found",
          };
        }
        const contentHash = attachment.sha256 ?? `r2key:${attachment.r2Key}`;

        let existing = await findKbDocumentByContentHash(userId, contentHash);
        if (!existing) existing = await findKbDocumentByAttachmentId(userId, attachment.id);
        if (existing) {
          return {
            messageIndex,
            filePart,
            docId: existing.id,
            attachmentId: attachment.id,
            r2Key: attachment.r2Key,
            title: attachment.name,
            contentHash,
            pipelineStatus: "dedup",
            errorMessage: existing.errorMessage,
          };
        }

        const docId = `d-${randomUUID()}`;
        return {
          messageIndex,
          filePart,
          docId,
          attachmentId: attachment.id,
          r2Key: attachment.r2Key,
          title: attachment.name,
          contentHash,
          pipelineStatus: "new",
          errorMessage: null,
        };
      } catch (err) {
        return {
          messageIndex,
          filePart,
          docId: null,
          attachmentId: null,
          r2Key,
          title: null,
          contentHash: null,
          pipelineStatus: "failed",
          errorMessage: (err as Error).message,
        };
      }
    }),
  );

  // ponytail: persist a "parsing" row for every new doc NOW so the
  // Settings UI sees the doc immediately (2s poll picks it up), and so
  // a later OCR / chunk failure still leaves a row in kb_documents —
  // resolveKbRefs then renders "[Failed: ...]" instead of silently
  // dropping the document context. folderId is required by the schema,
  // so we resolve the default folder up-front (was previously deferred
  // to chunkEmbedStoreNode — moving it here is the cheapest way to get
  // the row visible early). Each insert is independent; if it throws
  // (DB hiccup, race with the dedup insert from /api/kb/upload for a
  // duplicate sha256) we keep going — the in-memory docId is still
  // useful as a placeholder, and a future reprocess can recover.
  const folder = await ensureDefaultKbFolder(userId, "Attachments");
  const newDocs = processed.filter(
    (p) => p.pipelineStatus === "new" && p.docId !== null && p.attachmentId !== null,
  );
  await Promise.allSettled(
    newDocs.map(async (pf) => {
      try {
        await insertKbDocument({
          id: pf.docId!,
          userId,
          folderId: folder.id,
          attachmentId: pf.attachmentId!,
          title: pf.title ?? "untitled",
          contentType: "application/pdf",
          contentHash: pf.contentHash!,
          status: "parsing",
          errorMessage: null,
        });
      } catch (err) {
        console.error(`kbAgent screenshotNode: insertKbDocument failed for ${pf.docId}`, err);
      }
    }),
  );

  // ponytail: render + upload pages for every new doc. We can't run
  // screenshotPdf until we know which PDFs are new, so this second
  // pass resolves pages. Done sequentially per-doc (screenshotPdf is
  // CPU-ish), but upload to R2 is awaited in parallel inside.
  const pagesByDocId: Record<string, PageResult[]> = {};
  for (const pf of processed) {
    if (pf.pipelineStatus !== "new" || !pf.docId || !pf.r2Key) continue;
    try {
      const pdfBytes = await getObject(pf.r2Key);
      const rendered = await screenshotPdf({ pdfBytes, dpi: 200 });
      const pages: PageResult[] = await Promise.all(
        rendered.map(async (p) => {
          const key = `kb-tmp/${userId}/${pf.docId}/page-${p.pageIndex}.png`;
          const imageUrl = await uploadKbImage({ key, body: p.png });
          return { pageIndex: p.pageIndex, imageUrl, markdown: "" };
        }),
      );
      pagesByDocId[pf.docId] = pages;
    } catch (err) {
      // ponytail: render failure flips this PDF to "failed" — keep the
      // docId so the rewritten HumanMessage still carries a kb_ref
      // sibling, and
      // persist the failure on the row so the [Failed: ...] placeholder
      // resolves correctly in resolveKbRefs.
      pf.pipelineStatus = "failed";
      pf.errorMessage = (err as Error).message;
      try {
        await updateKbDocumentStatus(userId, pf.docId!, {
          status: "failed",
          errorMessage: pf.errorMessage,
        });
      } catch (statusErr) {
        console.error(
          `kbAgent screenshotNode: updateKbDocumentStatus failed for ${pf.docId}`,
          statusErr,
        );
      }
    }
  }

  return {
    userId,
    processedFiles: processed,
    pagesByDocId,
    status: "parsing",
  };
}

async function ocrNode(state: KbAgentStateShape) {
  const ocr = await getOcrModel();
  const system = new SystemMessage(KB_OCR_PAGE_PROMPT);
  const structured = ocr.withStructuredOutput(ocrPageSchema, { method: "jsonSchema" });

  // ponytail: one p-queue across ALL docs — caps total apimart
  // concurrency at OCR_CONCURRENCY regardless of how many PDFs were
  // in flight. Per-doc pages still complete in order (Promise.all per
  // doc preserves it).
  const queue = new PQueue({ concurrency: OCR_CONCURRENCY });

  const newDocs = state.processedFiles.filter(
    (p) =>
      p.pipelineStatus === "new" && p.docId !== null && state.pagesByDocId[p.docId] !== undefined,
  );

  const updatedPagesByDocId: Record<string, PageResult[]> = { ...state.pagesByDocId };
  const updatedProcessed = state.processedFiles.map((p) => ({ ...p }));

  const results = await Promise.allSettled(
    newDocs.map((pf) =>
      queue.add(async () => {
        const pages = state.pagesByDocId[pf.docId!];
        const ocrResults = await Promise.all(
          pages.map((p) =>
            structured
              .invoke(
                [
                  system,
                  new HumanMessage({
                    content: [{ type: "image_url", image_url: { url: p.imageUrl } }],
                  }),
                ],
                { tags: ["nostream"] },
              )
              .then((out) => ({ ...p, markdown: out.markdown.trim() })),
          ),
        );
        return { docId: pf.docId!, pages: ocrResults, messageIndex: pf.messageIndex };
      }),
    ),
  );

  results.forEach((r, i) => {
    const pf = newDocs[i];
    if (r.status === "fulfilled") {
      updatedPagesByDocId[r.value.docId] = r.value.pages;
    } else {
      // ponytail: updatedProcessed is a shallow copy of state.processedFiles —
      // `===` never matches. Find the index in the ORIGINAL array and apply
      // the update at the same slot in the copy. Order is preserved by filter.
      // KEEP docId so the rewritten HumanMessage's file part still
      // carries a kb_ref sibling — resolveKbRefs then renders
      // "[Failed: ...]" via the doc row we already wrote in
      // screenshotNode.
      const idx = state.processedFiles.indexOf(pf);
      if (idx >= 0) {
        updatedProcessed[idx] = {
          ...updatedProcessed[idx],
          pipelineStatus: "failed",
          errorMessage: (r.reason as Error).message,
        };
      }
    }
  });

  // ponytail: persist OCR failures to db so resolveKbRefs renders
  // [Failed: ...] (not "[Pending]") for the file part's kb_ref sibling
  // in the user's message. Best-effort — a DB hiccup here doesn't
  // change the agent's in-memory state, only what future resolves
  // show. ocrNode only touches "new" entries; "unknown" / pre-existing
  // "failed" rows (from screenshotNode render errors) don't get
  // re-updated here.
  const failedNew = updatedProcessed.filter(
    (p) =>
      p.pipelineStatus === "failed" &&
      p.docId !== null &&
      // only flip docs that came from this ocrNode pass, not entries
      // that screenshotNode already marked failed (those carry the
      // render error and were updated there).
      !state.processedFiles.find(
        (orig) => orig.docId === p.docId && orig.pipelineStatus === "failed",
      ),
  );
  if (failedNew.length > 0 && state.userId) {
    const userId = state.userId;
    await Promise.allSettled(
      failedNew.map(async (p) => {
        try {
          await updateKbDocumentStatus(userId, p.docId!, {
            status: "failed",
            errorMessage: p.errorMessage,
          });
        } catch (err) {
          console.error(`kbAgent ocrNode: updateKbDocumentStatus failed for ${p.docId}`, err);
        }
      }),
    );
  }

  return { pagesByDocId: updatedPagesByDocId, processedFiles: updatedProcessed };
}

async function chunkEmbedStoreNode(state: KbAgentStateShape) {
  const userId = state.userId;
  if (!userId) return { status: "failed" as const, errorMessage: "no userId" };

  // ponytail: per-doc chunk + embed + entity extract. Process all new
  // docs in parallel — each is independent. Failure of one doc flips
  // that entry to "failed" and we continue. The kb_documents row was
  // already written by screenshotNode (status="parsing"); we only
  // INSERT chunks here and then UPDATE the doc row to success/failed
  // once we're done. Keeping docId on failed entries so the rewritten
  // HumanMessage's file part still carries a kb_ref sibling →
  // resolveKbRefs renders [Failed: ...] instead of silently dropping
  // the document context.
  const newDocs = state.processedFiles.filter(
    (p) => p.pipelineStatus === "new" && p.docId !== null,
  );

  const chat = await getChatModel();
  const entitySchema = z.object({ entities: z.array(z.string()) });
  const embedder = await getEmbeddingModel();

  const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 200 });
  const entityQueue = new PQueue({ concurrency: ENTITY_CONCURRENCY });

  const updatedChunksByDocId: Record<string, ChunkSeed[]> = { ...state.chunksByDocId };
  const updatedProcessed = state.processedFiles.map((p) => ({ ...p }));
  const successfulDocIds: string[] = [];

  await Promise.allSettled(
    newDocs.map(async (pf) => {
      const docId = pf.docId!;
      const pages = state.pagesByDocId[docId] ?? [];
      const fullMarkdown = pages
        .map((p) => p.markdown)
        .filter((m) => m.length > 0)
        .join("\n\n");

      if (!fullMarkdown) {
        const idx = state.processedFiles.indexOf(pf);
        if (idx >= 0) {
          updatedProcessed[idx] = {
            ...updatedProcessed[idx],
            pipelineStatus: "failed",
            errorMessage: "empty markdown after OCR",
          };
        }
        return;
      }

      try {
        const splitDocs = await splitter.createDocuments([fullMarkdown]);
        const texts = splitDocs.map((d) => d.pageContent);
        const embeddings = await embedder.embedDocuments(texts);

        // ponytail: schema expects vector(1024) (kb_chunk.embedding +
        // HNSW index). If the embedder returns anything else, pgvector
        // rejects every insert with 22P02 — caught too late to be useful.
        // Fail fast with a single clear sentence instead.
        const actualDim = embeddings[0]?.length ?? 0;
        if (actualDim !== EMBEDDING_DIM) {
          throw new Error(
            `embedding dimension mismatch: schema expects ${EMBEDDING_DIM}, embedder returned ${actualDim}. Update lib/kb/schema.ts EMBEDDING_DIM + run the matching ALTER COLUMN migration.`,
          );
        }

        const seeds: ChunkSeed[] = await Promise.all(
          texts.map((text, i) =>
            entityQueue.add(async (): Promise<ChunkSeed> => {
              let entities: string[] = [];
              try {
                const out = await chat
                  .withStructuredOutput(entitySchema, { method: "jsonSchema" })
                  .invoke(
                    `Extract named entities (people, orgs, concepts, products) from this passage:\n\n${text}`,
                    {
                      tags: ["nostream"],
                    },
                  );
                entities = out.entities.slice(0, 20);
              } catch {
                // best-effort
              }
              return {
                ordinal: i,
                content: text,
                entities,
                embedding: embeddings[i] ?? [],
              };
            }),
          ),
        );

        await withKbTx(async (tx) => {
          await insertKbChunks(
            tx,
            seeds.map((s) => ({
              id: `c-${randomUUID()}`,
              documentId: docId,
              ordinal: s.ordinal,
              content: s.content,
              embedding: s.embedding,
              entities: s.entities,
            })) as never,
          );
        });
        invalidateKbDoc(userId, docId);
        updatedChunksByDocId[docId] = seeds;
        successfulDocIds.push(docId);
      } catch (err) {
        const idx = state.processedFiles.indexOf(pf);
        // ponytail: postgres.js throws FailedQueryError whose `.message`
        // is the full SQL + params dump (multi-KB), but the actual PG
        // SQLSTATE / detail / hint / constraint live on the error itself
        // (code/severity/detail/hint/constraint fields). Surface those
        // so the failure reason isn't buried in noise — user-facing
        // errorMessage stays small, verbose form goes to console.error
        // for debugging.
        const pgErr = err as Error & {
          code?: string;
          severity?: string;
          detail?: string;
          hint?: string;
          constraint?: string;
          position?: string;
          schema?: string;
          table?: string;
          column?: string;
          dataType?: string;
        };
        const reason = pgErr.code
          ? `${pgErr.code}: ${pgErr.detail ?? pgErr.message}${pgErr.hint ? ` (${pgErr.hint})` : ""}`
          : pgErr.message;
        console.error(
          `kbAgent chunkEmbedStoreNode: insertKbChunks failed for doc ${docId}: ${reason}`,
          {
            code: pgErr.code,
            severity: pgErr.severity,
            detail: pgErr.detail,
            hint: pgErr.hint,
            constraint: pgErr.constraint,
            position: pgErr.position,
            schema: pgErr.schema,
            table: pgErr.table,
            column: pgErr.column,
            dataType: pgErr.dataType,
          },
        );
        if (idx >= 0) {
          updatedProcessed[idx] = {
            ...updatedProcessed[idx],
            pipelineStatus: "failed",
            errorMessage: reason || pgErr.message,
          };
        }
      }
    }),
  );

  // ponytail: finalize each doc row in kb_documents. Successful docs
  // (chunks written) flip to "success". Failed entries are NOT
  // downgraded to status="failed" — OCR succeeded and the row already
  // says "parsing"; overwriting that would lose the OCR artifact and
  // mark the doc broken from the user's view even though retrying just
  // the chunk/embed step would rebuild the index. Leaving the row in
  // parsing keeps the OCR data visible (resolveKbRefs finds the row,
  // empty chunks → [Processing...] placeholder) and the Settings UI
  // badge stays "Parsing" until the user retries or the run finishes
  // a follow-up rebuild pass.
  //
  // in-memory `pipelineStatus: "failed"` still drives the HumanMessage
  // rewrite below — failed entries get a kb_ref sibling (so
  // resolveKbRefs can
  // surface the trace) but the doc row itself stays healthy.
  const finalized: Promise<unknown>[] = [];
  for (const docId of successfulDocIds) {
    finalized.push(
      updateKbDocumentStatus(userId, docId, { status: "success" }).catch((err) => {
        console.error(`kbAgent chunkEmbedStoreNode: status=success failed for ${docId}`, err);
      }),
    );
  }
  await Promise.allSettled(finalized);

  // ponytail: rewrite EVERY HumanMessage that had a PDF file part.
  // For each PDF we matched to a kb_document, KEEP the original file
  // part and stamp a `kb_ref` sibling onto it — `{docId, attachmentId?}`.
  // The front-end reads that sibling to deep-link the rendered file
  // tile into /settings/knowledge-base?doc=<id>.
  //
  // Why not emit a standalone kb_ref part: @assistant-ui/react-langgraph's
  // `contentToParts` filters unknown part types to null (default branch
  // returns null), so a `{ type: "kb_ref" }` part never reaches the
  // runtime. The SDK's `file` switch rebuilds the object from scratch
  // with only {type, filename, data, mimeType} — sibling fields might
  // also be stripped. We're trying the sibling-field approach first;
  // if the SDK proves to drop it, fall back to a patched SDK or a
  // custom message converter.
  //
  // Failure modes:
  //  - matched PDF (new / dedup / parsing): file part + kb_ref sibling.
  //  - non-PDF file part: drop (kbAgent never surfaces these to the
  //    model anyway — same as the prior behavior).
  //  - unknown / failed PDF with no docId: drop the file part (no
  //    docId to attach).
  const fileToDoc = new Map<string, { docId: string; attachmentId: string | null }>();
  for (const pf of updatedProcessed) {
    if (pf.docId) {
      fileToDoc.set(pf.filePart.data, { docId: pf.docId, attachmentId: pf.attachmentId });
    }
  }

  const messages = state.messages.map((m): BaseMessage => {
    if (!(m instanceof HumanMessage) || !Array.isArray(m.content)) return m;
    let changed = false;
    const newContent: unknown[] = [];
    for (const part of m.content) {
      if (isFilePart(part)) {
        const matched = fileToDoc.get(part.data);
        if (!matched) {
          // non-PDF or unknown/failed PDF with no docId → drop
          changed = true;
          continue;
        }
        changed = true;
        newContent.push({
          ...part,
          kb_ref: {
            docId: matched.docId,
            ...(matched.attachmentId ? { attachmentId: matched.attachmentId } : {}),
          },
        });
        continue;
      }
      newContent.push(part);
    }
    if (!changed) return m;
    return new HumanMessage({ content: newContent as never, id: m.id });
  });

  const hasFailure = updatedProcessed.some((p) => p.pipelineStatus === "failed");
  const allUnknown = updatedProcessed.every((p) => p.pipelineStatus === "unknown");
  const newDocCount = updatedProcessed.filter((p) => p.pipelineStatus === "new").length;
  const dedupCount = updatedProcessed.filter((p) => p.pipelineStatus === "dedup").length;

  // ponytail: status follows the loudest outcome. If anything failed
  // (OCR / chunk / render) the run is "failed" overall. Otherwise
  // "success". "parsing"/"pending" statuses live on the docs themselves
  // and surface through the resolve layer's placeholders.
  let status: KbAgentStateShape["status"] = "success";
  let errorMessage: string | null = null;
  if (allUnknown) {
    status = "failed";
    errorMessage = "no PDF could be processed";
  } else if (hasFailure) {
    status = "failed";
    const firstFailure = updatedProcessed.find((p) => p.pipelineStatus === "failed");
    errorMessage = firstFailure?.errorMessage ?? "kbAgent failed";
  } else if (newDocCount === 0 && dedupCount === 0) {
    status = "failed";
    errorMessage = "no PDF could be processed";
  }

  return {
    messages,
    processedFiles: updatedProcessed,
    chunksByDocId: updatedChunksByDocId,
    status,
    errorMessage,
  };
}

const builder = new StateGraph(KbAgentState)
  .addNode("screenshot", screenshotNode)
  .addNode("ocr", ocrNode)
  .addNode("chunkEmbedStore", chunkEmbedStoreNode)
  .addEdge(START, "screenshot")
  .addEdge("screenshot", "ocr")
  .addEdge("ocr", "chunkEmbedStore")
  .addEdge("chunkEmbedStore", END);

// ponytail: TWO compiled graphs from the same builder.
// - `kbAgent` (in-process subgraph): empty subgraphCheckpointerConfig.
//   mainAgent (`backend/agent.ts`) calls `.addNode("kbAgent", kbAgent)`
//   and the parent graph's checkpointer governs persistence. The
//   existing direct-node-call tests (tests/backend/kb-agent.test.ts)
//   bypass the parent and never set a thread_id — they rely on this
//   config being empty so no checkpoint write is attempted.
// - `graph` (standalone top-level assistant registered in
//   langgraph.json): gets the global checkpointer + store + callbacks
//   so observability + credit tracking + per-thread persistence work
//   for the synthetic "ingest this file" runs dispatched from
//   `lib/kb/ingest.fireIngestionRun()`.
//
// Both keep `name: "kbAgent"` so the runtime identifies the standalone
// assistant under the expected key.
export const kbAgent = builder.compile({
  name: "kbAgent",
  ...subgraphCheckpointerConfig,
});

const standaloneCompiled = builder.compile({
  name: "kbAgent",
  checkpointer,
  store,
});

type WithConfigPregel = (config: Record<string, unknown>) => typeof standaloneCompiled;
export const graph = (standaloneCompiled.withConfig as unknown as WithConfigPregel)({
  callbacks: [capturingHandler, creditTrackingHandler],
});
void END;
