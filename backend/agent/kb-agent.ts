import { END, START, StateGraph } from "@langchain/langgraph";
import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import PQueue from "p-queue";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { RunnableConfig } from "@langchain/core/runnables";
import { getChatModel, getEmbeddingModel, getOcrModel } from "@/backend/model";
import { KB_OCR_PAGE_PROMPT } from "@/backend/prompt/system";
import { capturingHandler, creditTrackingHandler } from "@/backend/callbacks";
import { checkpointer, subgraphCheckpointerConfig } from "@/backend/checkpointer";
import { store } from "@/backend/store";
import {
  KbAgentState,
  type KbAgentStateShape,
  type PageResult,
  type ProcessedFile,
} from "@/backend/state";
import { screenshotPdf } from "@/lib/kb/screenshot";
import {
  ensureDefaultKbFolder,
  findKbDocumentByContentHash,
  findKbDocumentByAttachmentId,
  findKbDocumentById,
  insertKbChunks,
  insertKbDocument,
  updateKbDocumentStatus,
  withKbTx,
} from "@/lib/kb/queries";
import { findAttachmentByR2Key } from "@/lib/attachments/queries";
import { extractAllPdfParts, isFilePart, stampKbRefOnFilename } from "@/lib/kb/extract";
import { invalidateKbDoc } from "@/lib/kb/cache";
import { EMBEDDING_DIM } from "@/lib/kb/schema";
import { r2KeyFromPublicUrl, uploadKbImage, getR2PublicBaseUrl, getObject } from "@/lib/r2/client";
import { KB_OCR_CONCURRENCY, KB_ENTITY_CONCURRENCY } from "@/lib/constants";

// ponytail: v3 KB ingest subgraph — per-doc state. Compiled once at
// module load, wired into agent.ts as `kbAgent`. Sits between
// RouterNode ("PDF → kbAgent") and the sub-agents.
//
// Flow:
//   START → prepareKBData → splitFileToImage → imageToMarkdown → rewriteMessages ─┬─▶ END
//                                                                                 └─▶ generateChunkEmbed → END
//                                                                                       (non-blocking, triggers generateChunkEmbedNode)
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

type ChunkSeed = { ordinal: number; content: string; entities: string[]; embedding: number[] };

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

function makeError(message: string): Partial<KbAgentStateShape> {
  return { status: "failed", errorMessage: message, processedFiles: [] };
}

// ---------------------------------------------------------------------------
// Node 1: prepareKBDataNode — DB queries + dedup + insert kb_documents row
// ---------------------------------------------------------------------------

async function prepareKBDataNode(
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
  // single invocation.
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
  // dropping the document context.
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
        console.error(`kbAgent prepareKBDataNode: insertKbDocument failed for ${pf.docId}`, err);
      }
    }),
  );

  return {
    userId,
    processedFiles: processed,
    status: "parsing",
  };
}

// ---------------------------------------------------------------------------
// Node 2: splitFileToImageNode — PDF rendering + R2 upload
// ---------------------------------------------------------------------------

async function splitFileToImageNode(state: KbAgentStateShape): Promise<Partial<KbAgentStateShape>> {
  const newDocs = state.processedFiles.filter(
    (p) => p.pipelineStatus === "new" && p.docId !== null && p.r2Key !== null,
  );

  const pagesByDocId: Record<string, PageResult[]> = {};
  const updatedProcessed = state.processedFiles.map((p) => ({ ...p }));

  for (const pf of newDocs) {
    try {
      const pdfBytes = await getObject(pf.r2Key!);
      const rendered = await screenshotPdf({ pdfBytes, dpi: 200 });
      const pages: PageResult[] = await Promise.all(
        rendered.map(async (p) => {
          const key = `kb-tmp/${state.userId}/${pf.docId}/page-${p.pageIndex}.png`;
          const imageUrl = await uploadKbImage({ key, body: p.png });
          return { pageIndex: p.pageIndex, imageUrl, markdown: "" };
        }),
      );
      pagesByDocId[pf.docId!] = pages;
      if (state.userId && pf.docId) {
        await updateKbDocumentStatus(state.userId, pf.docId, {
          status: "parsing",
          pages,
        });
      }
    } catch (err) {
      // ponytail: render failure flips this PDF to "failed" — keep the
      // docId so the rewritten HumanMessage still carries a kb_ref
      // sibling, and persist the failure on the row so the [Failed: ...]
      // placeholder resolves correctly in resolveKbRefs.
      const idx = state.processedFiles.indexOf(pf);
      if (idx >= 0) {
        updatedProcessed[idx] = {
          ...updatedProcessed[idx],
          pipelineStatus: "failed",
          errorMessage: (err as Error).message,
        };
      }
      if (state.userId && pf.docId) {
        try {
          await updateKbDocumentStatus(state.userId, pf.docId, {
            status: "failed",
            errorMessage: (err as Error).message,
          });
        } catch (statusErr) {
          console.error(
            `kbAgent splitFileToImageNode: updateKbDocumentStatus failed for ${pf.docId}`,
            statusErr,
          );
        }
      }
    }
  }

  return { pagesByDocId, processedFiles: updatedProcessed };
}

// ---------------------------------------------------------------------------
// Node 3: imageToMarkdownNode — OCR + fullMarkdown + fire-and-forget chunk
// ---------------------------------------------------------------------------

async function imageToMarkdownNode(state: KbAgentStateShape) {
  const ocr = await getOcrModel();
  const system = new SystemMessage(KB_OCR_PAGE_PROMPT);
  const structured = ocr.withStructuredOutput(ocrPageSchema, { method: "jsonSchema" });

  // ponytail: one p-queue across ALL docs — caps total apimart
  // concurrency at OCR_CONCURRENCY regardless of how many PDFs were
  // in flight. Per-doc pages still complete in order (Promise.all per
  // doc preserves it).
  const queue = new PQueue({ concurrency: KB_OCR_CONCURRENCY });

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

  const successfulDocIds: string[] = [];
  const failedNewDocs: ProcessedFile[] = [];

  for (let i = 0; i < updatedProcessed.length; i++) {
    const pf = updatedProcessed[i];
    if (pf.pipelineStatus !== "new" || !pf.docId) continue;
    const pages = updatedPagesByDocId[pf.docId] ?? [];
    const md = pages
      .map((p) => p.markdown)
      .filter((m) => m.length > 0)
      .join("\n\n");
    if (md) {
      successfulDocIds.push(pf.docId);
    } else {
      updatedProcessed[i] = {
        ...pf,
        pipelineStatus: "failed",
        errorMessage: "empty markdown after OCR",
      };
      failedNewDocs.push(updatedProcessed[i]);
    }
  }

  const failedOcrDocs = updatedProcessed.filter(
    (p) =>
      p.pipelineStatus === "failed" &&
      p.docId !== null &&
      state.pagesByDocId[p.docId] !== undefined &&
      !failedNewDocs.some((orig) => orig.docId === p.docId),
  );
  const allFailedNew = [...failedNewDocs, ...failedOcrDocs];

  if (state.userId) {
    const userId = state.userId;
    await Promise.allSettled([
      ...allFailedNew.map(async (p) => {
        await updateKbDocumentStatus(userId, p.docId!, {
          status: "failed",
          errorMessage: p.errorMessage,
        });
      }),
      ...successfulDocIds.map(async (docId) => {
        await updateKbDocumentStatus(userId, docId, {
          status: "success",
          pages: updatedPagesByDocId[docId],
        });
      }),
    ]);
  }

  return { pagesByDocId: updatedPagesByDocId, processedFiles: updatedProcessed };
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Node 5: rewriteMessagesNode — stamp kb_ref on file parts + compute status
// ---------------------------------------------------------------------------

function rewriteMessagesNode(state: KbAgentStateShape): Partial<KbAgentStateShape> {
  const fileToDoc = new Map<string, { docId: string; attachmentId: string | null }>();
  for (const pf of state.processedFiles) {
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
        // ponytail: already-stamped parts carry through untouched.
        if (part.kb_ref) {
          newContent.push(part);
          continue;
        }
        const matched = fileToDoc.get(part.data);
        if (!matched) {
          // non-PDF or unknown/failed PDF with no docId → drop
          changed = true;
          continue;
        }
        changed = true;
        // ponytail: stamp BOTH the kb_ref sibling AND the filename
        // prefix on the same write. stampKbRefOnFilename is idempotent
        // so a re-stamp is a no-op.
        const baseFilename =
          typeof part.filename === "string"
            ? part.filename
            : typeof part.metadata?.filename === "string"
              ? part.metadata.filename
              : undefined;
        const stampedFilename = stampKbRefOnFilename(baseFilename, matched.docId);
        newContent.push({
          ...part,
          kb_ref: {
            docId: matched.docId,
            ...(matched.attachmentId ? { attachmentId: matched.attachmentId } : {}),
          },
          filename: stampedFilename,
          metadata: { ...part.metadata, filename: stampedFilename },
        });
        continue;
      }
      newContent.push(part);
    }
    if (!changed) return m;
    return new HumanMessage({ content: newContent as never, id: m.id });
  });

  // ponytail: status follows the loudest outcome. If anything failed
  // (OCR / render) the run is "failed" overall. Otherwise "success".
  const hasFailure = state.processedFiles.some((p) => p.pipelineStatus === "failed");
  const allUnknown = state.processedFiles.every((p) => p.pipelineStatus === "unknown");
  const newDocCount = state.processedFiles.filter((p) => p.pipelineStatus === "new").length;
  const dedupCount = state.processedFiles.filter((p) => p.pipelineStatus === "dedup").length;

  let status: KbAgentStateShape["status"] = "success";
  let errorMessage: string | null = null;
  if (allUnknown) {
    status = "failed";
    errorMessage = "no PDF could be processed";
  } else if (hasFailure) {
    status = "failed";
    const firstFailure = state.processedFiles.find((p) => p.pipelineStatus === "failed");
    errorMessage = firstFailure?.errorMessage ?? "kbAgent failed";
  } else if (newDocCount === 0 && dedupCount === 0) {
    status = "failed";
    errorMessage = "no PDF could be processed";
  }

  return { messages, status, errorMessage };
}

// ---------------------------------------------------------------------------
// Node 6: generateChunkEmbedNode — chunk + embed + entity + insert
// ponytail: registered as a LangGraph node but the heavy work runs inside
// a fire-and-forget IIFE so the node returns in milliseconds and never
// blocks the main kbAgent or the RAG chat loop. RunnableConfig is
// captured for callback propagation into the entity-extract LLM call.
// ---------------------------------------------------------------------------

async function generateChunkEmbedNode(
  state: KbAgentStateShape,
  config?: RunnableConfig,
): Promise<Partial<KbAgentStateShape>> {
  if (state.userId) {
    for (const pf of state.processedFiles) {
      if (pf.pipelineStatus === "new" && pf.docId) {
        const docId = pf.docId;
        const userId = state.userId;

        // ponytail: fire-and-forget so the graph node completes instantly.
        void (async () => {
          try {
            const doc = await findKbDocumentById(userId, docId);
            if (!doc) {
              throw new Error(`Document ${docId} not found`);
            }
            const pages = (doc.pages ?? []) as Array<{
              pageIndex: number;
              imageUrl: string;
              markdown: string;
            }>;
            const fullMarkdown = pages
              .map((p) => p.markdown)
              .filter((m) => m && m.length > 0)
              .join("\n\n");
            if (!fullMarkdown) {
              throw new Error(`Document ${docId} has no markdown content extracted yet`);
            }
            const chat = await getChatModel();
            const entitySchema = z.object({ entities: z.array(z.string()) });
            const embedder = await getEmbeddingModel();
            const splitter = new RecursiveCharacterTextSplitter({
              chunkSize: 1000,
              chunkOverlap: 200,
            });
            const entityQueue = new PQueue({ concurrency: KB_ENTITY_CONCURRENCY });

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
                        { ...config, tags: ["nostream"] },
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
          } catch (err) {
            // ponytail: postgres.js throws FailedQueryError whose `.message`
            // is the full SQL + params dump. Surface the PG SQLSTATE / detail
            // for debugging; keep user-facing errorMessage small.
            const pgErr = err as Error & {
              code?: string;
              detail?: string;
              hint?: string;
            };
            const reason = pgErr.code
              ? `${pgErr.code}: ${pgErr.detail ?? pgErr.message}${pgErr.hint ? ` (${pgErr.hint})` : ""}`
              : pgErr.message;
            console.error(
              `kbAgent generateChunkEmbedNode: failed for doc ${docId}: ${reason}`,
              pgErr,
            );
            // ponytail: imageToMarkdownNode already flipped status="success".
            // If chunk/embed fails, roll back to "failed" so Settings UI shows
            // the failure and the user can reprocess.
            try {
              await updateKbDocumentStatus(userId, docId, {
                status: "failed",
                errorMessage: reason,
              });
            } catch (statusErr) {
              console.error(
                `kbAgent generateChunkEmbedNode: status=failed flip failed for ${docId}`,
                statusErr,
              );
            }
          }
        })();
      }
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// Graph builder + dual compilation
// ---------------------------------------------------------------------------

function routeAfterRewrite(state: KbAgentStateShape): (string | typeof END)[] {
  const destinations: (string | typeof END)[] = [END];
  const hasNew = state.processedFiles.some((p) => p.pipelineStatus === "new");
  if (hasNew) {
    destinations.push("generateChunkEmbed");
  }
  return destinations;
}

const builder = new StateGraph(KbAgentState)
  .addNode("prepareKBData", prepareKBDataNode)
  .addNode("splitFileToImage", splitFileToImageNode)
  .addNode("imageToMarkdown", imageToMarkdownNode)
  .addNode("rewriteMessages", rewriteMessagesNode)
  .addNode("generateChunkEmbed", generateChunkEmbedNode)
  .addEdge(START, "prepareKBData")
  .addEdge("prepareKBData", "splitFileToImage")
  .addEdge("splitFileToImage", "imageToMarkdown")
  .addEdge("imageToMarkdown", "rewriteMessages")
  .addConditionalEdges("rewriteMessages", routeAfterRewrite, {
    generateChunkEmbed: "generateChunkEmbed",
    __end__: END,
  })
  .addEdge("generateChunkEmbed", END);

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
