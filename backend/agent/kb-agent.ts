import { END, START, StateGraph } from "@langchain/langgraph";
import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { MarkdownTextSplitter } from "@langchain/textsplitters";
import { Document } from "@langchain/core/documents";
import PQueue from "p-queue";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { RunnableConfig } from "@langchain/core/runnables";
import { getEmbeddingModel, getExtractModel, getOcrModel } from "@/backend/model";
import {
  KB_OCR_PAGE_PROMPT,
  KB_ENTITY_EXTRACTION_SYSTEM_PROMPT,
  KB_ENTITY_ALIGNMENT_SYSTEM_PROMPT,
} from "@/backend/prompt/system";
import { creditTrackingHandler } from "@/backend/callbacks";
import { checkpointer, subgraphCheckpointerConfig } from "@/backend/checkpointer";
import { store } from "@/backend/store";
import {
  KbAgentState,
  type KbAgentStateShape,
  type PageResult,
  type ProcessedFile,
} from "@/backend/state";
import { screenshotPdf } from "@/lib/kb/screenshot";
import { extractPdfText } from "@/lib/kb/text";
import {
  ensureDefaultKbFolder,
  findKbDocumentByContentHash,
  findKbDocumentByAttachmentId,
  findKbDocumentById,
  findKbChunksByDocumentId,
  insertKbChunks,
  insertKbDocument,
  markAllKbChunksParsingForDocInTx,
  markKbChunkFailed,
  markKbChunkSuccess,
  updateKbChunkForFailure,
  updateKbChunkForSuccess,
  updateKbChunkGraphData,
  updateKbDocumentStatus,
  withKbTx,
} from "@/lib/kb/queries";
import { findAttachmentByR2Key } from "@/lib/attachments/queries";
import { extractAllPdfParts, isFilePart, stampKbRefOnFilename } from "@/lib/kb/extract";
import { invalidateKbDoc } from "@/lib/kb/cache";
import { EMBEDDING_DIM } from "@/lib/kb/schema";
import { r2KeyFromPublicUrl, uploadKbImage, getR2PublicBaseUrl, getObject } from "@/lib/r2/client";
import { KB_OCR_CONCURRENCY, KB_ENTITY_CONCURRENCY } from "@/lib/constants";

const KB_CHUNK_SIZE = 1024;
const KB_CHUNK_OVERLAP = 200;

// ponytail: v3 KB ingest subgraph — per-doc state. Compiled once at
// module load, wired into agent.ts as `kbAgent`. Sits between
// RouterNode ("PDF → kbAgent") and the sub-agents.
//
// Flow:
//   START → prepareKBData → splitFilePage → pageToMarkdown → rewriteMessages ─┬─▶ END
//                                                                             └─▶ generateChunkEmbed → END
//                                                                                   (non-blocking, triggers generateChunkEmbedNode)
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

// ponytail: debug toggle. When true, generateChunkEmbedNode bails out
// before firing its per-row entity-LLM + write-back arms. Use to
// isolate the INSERT path vs the LLM path when reproducing a
// partial-pipeline failure — flip in source, restart backend, reprocess
// the target doc, then revert.
const SKIP_CHUNK_TO_ENTRIES = false;

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

const lightRagSchema = z.object({
  entities: z
    .array(
      z.object({
        name: z.string().describe("Entity name (e.g., person, tech stack, system component)"),
        type: z.string().describe("Category of the entity (e.g., Person, Tool, Concept)"),
        description: z.string().describe("Brief description of this entity in the current context"),
      }),
    )
    .describe("All distinct entities mentioned in the text"),
  relationships: z
    .array(
      z.object({
        source: z.string().describe("Source entity name"),
        target: z.string().describe("Target entity name"),
        relation: z.string().describe("The action or logical connection between them"),
        type: z.string().describe("Alias for the relation (used by some models)"),
        description: z.string().describe("Detailed explanation of this relationship"),
      }),
    )
    .describe("Directed relationships connecting the extracted entities"),
  themes: z
    .array(z.string())
    .describe(
      "3 to 5 high-level macroscopic keywords or core concepts summarizing this chunk's main point",
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
  config?: {
    configurable?: {
      userId?: string;
      mode?: "full" | "chunksOnly" | "retryFailed";
      docId?: string;
      forceRerun?: boolean;
    };
  },
): Promise<Partial<KbAgentStateShape>> {
  // ponytail: chunksOnly / retryFailed dispatch from POST /reprocess.
  // We bypass the entire attachment/file-part lookup chain and reuse
  // the existing kb_document row's pages[].markdown directly:
  //   - splitFileToPageNode: r2Key=null → filter drops it → no-op
  //   - pageToMarkdownNode: retryFailed runs OCR only on failed pages;
  //     chunksOnly skips OCR entirely.
  //   - rewriteMessagesNode: guarded → no messages rewrite
  //   - generateChunkEmbedNode: pipelineStatus="new" → runs
  // dispatchable mode precedence: config.configurable (per-run
  // override set by fireIngestionRun) wins over state.mode (default
  // "full" in the schema).
  const mode = config?.configurable?.mode ?? state.mode ?? "full";

  const userId = config?.configurable?.userId ?? state.userId;
  if (!userId) return makeError("user not provided");

  if (mode === "chunksOnly" || mode === "retryFailed") {
    // ponytail: chunksOnly / retryFailed requires an explicit docId either from
    // config.configurable.docId (per-run) or state.docId. fallback
    // to the explicit dispatch path. fail closed if neither set.
    const targetDocId = config?.configurable?.docId ?? state.docId;
    if (!targetDocId) {
      return makeError(`${mode} requires docId`);
    }
    const doc = await findKbDocumentById(userId, targetDocId);
    if (!doc) return makeError(`doc ${targetDocId} not found`);
    if (doc.status !== "success" && doc.status !== "failed" && doc.status !== "parsing") {
      return makeError(
        `${mode} requires settled doc or parsing doc, got status='${doc.status}'. Run full reprocess first.`,
      );
    }
    const pages = (doc.pages ?? []) as PageResult[];
    // ponytail: stub FilePart is required by ProcessedFile.shape but
    // rewriteMessagesNode skips the stamp pass under mode=
    // "chunksOnly" / "retryFailed" so the values are never read. url/data empty →
    // resolveKbRefs won't try to look up a public R2 path that
    // doesn't exist for this synthetic dispatch.
    const stubFilePart = { type: "file" as const, url: "", data: "", metadata: {} as never };
    return {
      userId,
      mode,
      docId: doc.id,
      pagesByDocId: { [doc.id]: pages },
      processedFiles: [
        {
          messageIndex: -1,
          filePart: stubFilePart as never,
          docId: doc.id,
          attachmentId: doc.attachmentId,
          // r2Key=null → splitFileToPageNode filter rejects this entry
          // (its filter chains `&& p.r2Key !== null`), so PDF rendering
          // + screenshot + image upload are skipped.
          r2Key: null,
          title: doc.title,
          contentHash: doc.contentHash,
          // pipelineStatus="new" drives both routeAfterRewrite (pushes
          // generateChunkEmbed) AND generateChunkEmbedNode's own filter
          // (only acts on "new" entries).
          pipelineStatus: "new",
          errorMessage: null,
          existingStatus: doc.status,
        },
      ],
      // preserve doc's terminal status (or force parsing for live UI if retryFailed)
      status: mode === "retryFailed" ? "parsing" : doc.status,
      errorMessage: null,
    };
  }

  const pdfs = extractAllPdfParts(state.messages);
  if (pdfs.length === 0) return makeError("no PDF file parts found");

  const base = getR2PublicBaseUrl();

  // ponytail: per-PDF processing runs in parallel — each PDF is
  // independent, failures isolated to one entry, and the LRU on
  // findKbDocumentByContentHash makes repeat lookups free within a
  // single invocation.
  const processed = await Promise.all(
    pdfs.map(async ({ messageIndex, filePart }): Promise<ProcessedFile> => {
      const url = filePart.url || filePart.data;
      const r2Key = r2KeyFromPublicUrl(url, base);
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
          // ponytail: dedup short-circuit only when the row already
          // ran the pipeline to completion (`success`/`failed`) — a
          // stale `pending` row means a prior kbAgent run never
          // landed its status writes (the t- prefix bug, dropped
          // dispatch, etc.), and a second dispatch should re-process
          // the file pointing at the SAME row id so the row actually
          // flips to `success`. Falling through to the fresh-create
          // branch would insert a NEW docId and leave the stale row
          // stuck forever — instead, reuse existing.id with a `new`
          // pipelineStatus so splitFileToPageNode writes back to it.
          const forceRerun = config?.configurable?.forceRerun ?? false;
          if (!forceRerun && (existing.status === "success" || existing.status === "failed")) {
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
              existingStatus: existing.status,
            };
          }
          // pending/parsing rows: reuse the row, re-process the file
          return {
            messageIndex,
            filePart,
            docId: existing.id,
            attachmentId: attachment.id,
            r2Key: attachment.r2Key,
            title: attachment.name,
            contentHash,
            pipelineStatus: "new",
            errorMessage: null,
            existingStatus: existing.status,
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
        // 23505 unique_violation: a row with this id already exists
        // (the dedup-pending branch reuses the existing docId so the
        // OCR pipeline writes its status back to that row). Flip the
        // row from `pending` to `parsing` to surface progress.
        // ponytail: Drizzle wraps PostgresError in DrizzleQueryError —
        // top-level `err.code` is undefined; the actual pg code lives
        // on `err.cause.code`. Same lookup pattern as
        // ensureDefaultKbFolder above (lib/kb/queries.ts:77).
        const code =
          (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
        if (code === "23505") {
          try {
            await updateKbDocumentStatus(userId, pf.docId!, {
              status: "parsing",
              errorMessage: null,
            });
          } catch (statusErr) {
            console.error(
              `kbAgent prepareKBDataNode: recovery UPDATE failed for ${pf.docId}`,
              statusErr,
            );
          }
          return;
        }
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
// Node 2: splitFileToPageNode — PDF rendering + text extraction + R2 upload
// ---------------------------------------------------------------------------

async function splitFileToPageNode(state: KbAgentStateShape): Promise<Partial<KbAgentStateShape>> {
  const newDocs = state.processedFiles.filter(
    (p) => p.pipelineStatus === "new" && p.docId !== null && p.r2Key !== null,
  );

  const pagesByDocId: Record<string, PageResult[]> = {};
  const updatedProcessed = state.processedFiles.map((p) => ({ ...p }));

  for (const pf of newDocs) {
    try {
      const pdfBytes = await getObject(pf.r2Key!);
      const [rendered, extracted] = await Promise.all([
        screenshotPdf({ pdfBytes, dpi: 250 }),
        extractPdfText({ pdfBytes }),
      ]);
      const textByPage = Object.fromEntries(extracted.map((e) => [e.pageIndex, e.text]));
      const pages: PageResult[] = await Promise.all(
        rendered.map(async (p) => {
          const key = `kb-tmp/${state.userId}/${pf.docId}/page-${p.pageIndex}.png`;
          const imageUrl = await uploadKbImage({ key, body: p.png });
          return {
            pageIndex: p.pageIndex,
            imageUrl,
            markdown: "",
            referenceText: textByPage[p.pageIndex] ?? "",
            status: "pending",
          };
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

      console.error("kbAgent splitFileToPageNode", err);

      if (state.userId && pf.docId) {
        try {
          await updateKbDocumentStatus(state.userId, pf.docId, {
            status: "failed",
            errorMessage: (err as Error).message,
          });
        } catch (statusErr) {
          console.error(
            `kbAgent splitFileToPageNode: updateKbDocumentStatus failed for ${pf.docId}`,
            statusErr,
          );
        }
      }
    }
  }

  return { pagesByDocId, processedFiles: updatedProcessed };
}

// ---------------------------------------------------------------------------
// Node 3: pageToMarkdownNode — OCR + fullMarkdown + fire-and-forget chunk
// ---------------------------------------------------------------------------

async function pageToMarkdownNode(state: KbAgentStateShape) {
  // ponytail: chunksOnly dispatch reuses doc.pages[].markdown as-is,
  // so OCR is by definition out of scope. Returning the original
  // pagesByDocId + processedFiles without any work keeps the graph
  // edges valid while skipping a full re-render that the user
  // explicitly asked NOT to do.
  if (state.mode === "chunksOnly") {
    return {
      pagesByDocId: state.pagesByDocId,
      processedFiles: state.processedFiles,
    };
  }

  const ocrModel = await getOcrModel();

  const system = new SystemMessage(KB_OCR_PAGE_PROMPT);
  const structured = ocrModel.withStructuredOutput(ocrPageSchema, { method: "jsonSchema" });

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
        const controller = new AbortController();
        let hasFailed = false;

        const ocrResults = await Promise.all(
          pages.map(async (p) => {
            if (
              state.mode === "retryFailed" &&
              (p.markdown ?? "").trim().length > 0 &&
              !p.errorMessage
            ) {
              return p;
            }

            if (hasFailed || controller.signal.aborted) {
              return {
                ...p,
                markdown: "",
                status: "failed" as const,
                errorMessage:
                  "Bypassed: OCR aborted due to another page failure in the same document",
              };
            }

            const contentParts: Array<{ type: string; [key: string]: unknown }> = [
              { type: "image_url", image_url: { url: p.imageUrl } },
            ];
            if (p.referenceText?.trim()) {
              contentParts.push({
                type: "text",
                text: `Reference text extracted directly from the PDF (may contain layout noise — trust the image for structure):\n\n${p.referenceText}`,
              });
            }
            try {
              if (hasFailed || controller.signal.aborted) {
                return {
                  ...p,
                  markdown: "",
                  status: "failed" as const,
                  errorMessage:
                    "Bypassed: OCR aborted due to another page failure in the same document",
                };
              }
              const out = (await structured.invoke(
                [system, new HumanMessage({ content: contentParts })],
                { tags: ["nostream"], signal: controller.signal },
              )) as z.infer<typeof ocrPageSchema>;
              return {
                ...p,
                markdown: out.markdown.trim(),
                status: "success" as const,
                errorMessage: undefined,
              };
            } catch (err) {
              hasFailed = true;
              controller.abort();
              console.error(
                `kbAgent pageToMarkdownNode: OCR failed for doc ${pf.docId} page ${p.pageIndex}:`,
                err,
              );
              const isAborted =
                err instanceof Error &&
                (err.name === "AbortError" || err.message?.toLowerCase().includes("abort"));
              const msg = isAborted
                ? "Bypassed: OCR aborted due to another page failure in the same document"
                : err instanceof Error
                  ? err.message
                  : String(err);
              return { ...p, markdown: "", status: "failed" as const, errorMessage: msg };
            }
          }),
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
    const hasAnyFailedPage = pages.some((p) => !!p.errorMessage || !(p.markdown ?? "").trim());
    if (pages.length > 0 && !hasAnyFailedPage) {
      successfulDocIds.push(pf.docId);
    } else {
      const pageErrors = pages
        .map((p) => p.errorMessage)
        .filter((e): e is string => !!e && e.length > 0);
      const uniqueErrors = Array.from(new Set(pageErrors));
      const combinedError =
        uniqueErrors.length === 1
          ? uniqueErrors[0]
          : uniqueErrors.length > 1
            ? `OCR failed on some pages: ${uniqueErrors.join("; ")}`
            : "some pages have empty markdown after OCR";
      updatedProcessed[i] = {
        ...pf,
        pipelineStatus: "failed",
        errorMessage: combinedError,
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
          pages: updatedPagesByDocId[p.docId!] ?? null,
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

async function rewriteMessagesNode(state: KbAgentStateShape): Promise<Partial<KbAgentStateShape>> {
  // ponytail: chunksOnly dispatch has no messages to stamp — the
  // synthetic fireIngestionRun HumanMessage (or empty payload) never
  // carries a chat-context file part. Skip the stamp pass entirely
  // and forward state.messages untouched. The empty filePart.url/data
  // we constructed in prepareKBDataNode means fileToDoc below stays
  // empty; this guard avoids the unnecessary iteration + isHumanLike
  // rebuild cost.
  if (state.mode === "chunksOnly" || state.mode === "retryFailed") {
    return {
      messages: state.messages,
      status: state.status,
      errorMessage: null,
    };
  }

  const fileToDoc = new Map<string, { docId: string; attachmentId: string | null }>();
  for (const pf of state.processedFiles) {
    if (pf.docId) {
      const url = pf.filePart.url || pf.filePart.data;
      fileToDoc.set(url, { docId: pf.docId, attachmentId: pf.attachmentId });
    }
  }

  const messages = state.messages.map((m): BaseMessage => {
    // ponytail: match BOTH HumanMessage instance AND plain
    // `{type:"human", content:[...]}` rehydration form (see
    // lib/kb/extract.ts isHumanLike comment — the standalone
    // runs.create path produces the plain-object form after the
    // MessagesValue reducer round-trips). Without the type fallback
    // the rewrite skips the message and the kb_ref sibling never
    // lands on the file part.
    const mType = (m as { type?: unknown }).type;
    const isHuman = m instanceof HumanMessage || mType === "human";
    if (!isHuman || !Array.isArray(m.content)) return m;
    let changed = false;
    const newContent: unknown[] = [];
    for (const part of m.content) {
      if (isFilePart(part)) {
        // ponytail: already-stamped parts carry through untouched.
        if (part.kb_ref) {
          newContent.push(part);
          continue;
        }
        const url = part.url || part.data;
        const matched = fileToDoc.get(url);
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

  // ponytail: dedup row status sync. When kbAgent dedupes onto an
  // existing kb_document row whose prior run stalled (status=pending),
  // the row never gets a write — splitFileToPage / pageToMarkdown
  // filter updates to `pipelineStatus === "new"`. Read each dedup'd
  // docId's CURRENT row state and write it back. Best-effort: a
  // mid-write DB hiccup doesn't fail the run; the chat dedup
  // contract just needs the row to eventually converge.
  if (state.userId) {
    const dedupRows = state.processedFiles.filter(
      (p) => p.pipelineStatus === "dedup" && p.docId !== null,
    );
    await Promise.allSettled(
      dedupRows.map(async (pf) => {
        const row = await findKbDocumentById(state.userId!, pf.docId!);
        if (!row) return;
        // Forward the current row state so the user sees the settled
        // status (success / failed) — that's what they uploaded for.
        // Skip write if it's already at terminal state (avoid
        // rewriting a success to success). Only sync forward when
        // the row is currently pending/parsing.
        // ponytail: forward whatever the dedup target's actual current
        // state is, including intermediate (`parsing`/`pending`).
        // Re-running kbAgent on the dedup target SHOULD surface a
        // real progress signal even if the prior run stalled. The
        // row is read-fresh here so a row that was previously
        // `pending` but is now `success` gets flipped to `success`.
        await updateKbDocumentStatus(state.userId!, pf.docId!, {
          status: row.status,
          errorMessage: row.errorMessage,
          pages: row.pages ?? null,
        });
      }),
    );
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
  console.log(
    `[kbAgent] Entering generateChunkEmbedNode, files=`,
    state.processedFiles.map((p) => ({ docId: p.docId, status: p.pipelineStatus })),
  );
  if (state.userId) {
    for (const pf of state.processedFiles) {
      if (pf.pipelineStatus === "new" && pf.docId) {
        const docId = pf.docId;
        const userId = state.userId;

        console.log(`[kbAgent] Starting background chunking task for docId=${docId}`);
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
            console.log(
              `[kbAgent] Background task: loaded docId=${docId}, pages count=${pages.length}, fullMarkdown length=${fullMarkdown.length}`,
            );
            if (!fullMarkdown) {
              throw new Error(`Document ${docId} has no markdown content extracted yet`);
            }
            // ponytail: entity-extract LLM routes through the extract
            // pool so admin can flag a cheaper model (e.g. gpt-4o-mini)
            // for this work without forcing the same model on the extractModel
            // default. Falls back to the extractModel pool when no extract-
            // tagged model is registered (see getExtractModel).
            const extractModel = await getExtractModel();
            const embedder = await getEmbeddingModel();

            const lengthSplitter = new MarkdownTextSplitter({
              chunkSize: KB_CHUNK_SIZE,
              chunkOverlap: KB_CHUNK_OVERLAP,
            });
            const entityQueue = new PQueue({ concurrency: KB_ENTITY_CONCURRENCY });

            const splitDocs = await lengthSplitter.createDocuments([fullMarkdown]);
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

            // ponytail: allocate ids up front (one per chunk) so we can
            // mark each chunk success/failed independently after the
            // batch insert. Without per-chunk ids we'd have to write
            // `UPDATE kb_chunk SET status=... WHERE document_id=... AND
            // ordinal=?`, but with multi-run reprocesses the ordinal
            // space can briefly overlap; chunk id is the canonical
            // handle. ids are stable across this run — even if the
            // tx fails midway, the partial set is identifiable.
            const chunkIds = texts.map(() => `c-${randomUUID()}`);

            // ponytail: 3-stage chunk lifecycle, observable per
            // chunk so the UI polling can read real progress.
            //
            //   1. INSERT all rows at status='pending'  ← chunk
            //      appeared in DB, embedding LLM ran, OCR has
            //      finished, but entities haven't been extracted yet
            //   2. UPDATE all rows to 'parsing'           ← entity LLM
            //      dispatch started; the 'parsing' frame is short
            //      (KB_ENTITY_CONCURRENCY decides total work-time) but
            //      the UI now has a real signal to surface
            //   3. UPDATE per-row to success/failed     ← individual
            //      outcomes land; failures DO NOT downgrade
            //      kb_document (Step 3 contract)
            //
            // Step 1+2 live in one withKbTx so the row INSERT and the
            // status flip are atomic from the UI's perspective —
            // polling either sees nothing or 'parsing', never the
            // 'pending' frame after a successful INSERT (which would
            // feel like the pipeline stalled).
            await withKbTx(async (tx) => {
              await insertKbChunks(
                tx,
                texts.map((text, i) => ({
                  id: chunkIds[i]!,
                  documentId: docId,
                  ordinal: i,
                  content: text,
                  embedding: embeddings[i] ?? [],
                  entities: [],
                  // status defaults to 'pending' on insert.
                })) as never,
              );
              await markAllKbChunksParsingForDocInTx(tx, docId);
            });
            console.log(
              `[kbAgent] Background task: successfully inserted ${texts.length} chunks for docId=${docId}`,
            );

            // ponytail: per-row, streaming write-back. Each task writes
            // ITS OWN row the moment its entity LLM resolves — no
            // `Promise.all` to await siblings, no `results[]` buffer.
            // The 2s UI poll sees chunks flip from `parsing` →
            // `success`/`failed` one by one as each LLM lands.
            // Otherwise the row status lives in two states
            // (`parsing` for ~30s then `success` everywhere) and the
            // preview's "Indexed N/N, K failed" never moves while
            // the pipeline is still grinding. Each task wraps its
            // DB writes in a per-row try/catch so a single row's
            // UPDATE rejection can't crash the queued task and
            // silence its siblings.

            // ponytail: debug bail-out kept behind a const toggle so
            // oxlint's no-unreachable stays quiet. Flip to `true` to
            // isolate one of the Promise.allSettled arms (entity-LLM
            // vs insert vs per-row write-back) when reproducing a
            // partial-pipeline failure.
            if (SKIP_CHUNK_TO_ENTRIES) {
              return;
            }
            await Promise.allSettled(
              texts.map((text, i) =>
                entityQueue.add(async (): Promise<void> => {
                  const chunkId = chunkIds[i]!;
                  const docTitle = doc.title ?? "Unknown Document";

                  const systemMessage = new SystemMessage(KB_ENTITY_EXTRACTION_SYSTEM_PROMPT);
                  const humanMessage = new HumanMessage(
                    `Context Document Title: [${docTitle}]\n` +
                      `Chunk: [${i + 1} / ${texts.length}]\n\n` +
                      `Text to extract:\n${text}`,
                  );

                  try {
                    const out = (await extractModel
                      .withStructuredOutput(lightRagSchema, { method: "jsonSchema" })
                      .invoke([systemMessage, humanMessage], {
                        ...config,
                        tags: ["nostream"],
                      })) as z.infer<typeof lightRagSchema>;
                    const normalizedOut = {
                      entities: (out.entities ?? []).map((e) => ({
                        name: e.name,
                        type: e.type,
                        description: e.description ?? "",
                      })),
                      relationships: (out.relationships ?? []).map((r) => ({
                        source: r.source,
                        target: r.target,
                        relation: r.relation || r.type || "",
                        description: r.description ?? "",
                      })),
                      themes: out.themes ?? [],
                    };
                    // write-back: entities + status='success' in one go
                    // so the row never sits at success with a blank
                    // entities field.
                    await Promise.allSettled([
                      updateKbChunkForSuccess(chunkId, normalizedOut),
                      markKbChunkSuccess(chunkId),
                    ]);
                  } catch (err) {
                    // entity-extract LLM failure (or per-row DB
                    // write) — surface as kb_chunk.status='failed'
                    // + errorMessage. kb_document stays success
                    // (Step 3 contract).
                    const msg = err instanceof Error ? (err as any).message : String(err);
                    console.error(
                      `kbAgent generateChunkEmbedNode: chunk ${chunkId} failed (doc ${docId} ordinal ${i}): ${msg}`,
                      err as any,
                    );
                    try {
                      await Promise.allSettled([
                        updateKbChunkForFailure(chunkId, msg),
                        markKbChunkFailed(chunkId, msg),
                      ]);
                    } catch (writeErr) {
                      console.error(
                        `kbAgent generateChunkEmbedNode: failed-row write-back itself errored for chunk ${chunkId}:`,
                        writeErr,
                      );
                    }
                  }
                }),
              ),
            );

            // ponytail: Entity Alignment (Resolution) Post-Processor
            try {
              // 1. Fetch all successfully saved chunks for this document
              const dbChunks = await findKbChunksByDocumentId(userId, docId);
              const successChunks = dbChunks.filter((c) => c.status === "success");

              // 2. Gather all unique entities
              const allEntityNames = new Set<string>();
              for (const c of successChunks) {
                for (const e of c.entities ?? []) {
                  if (e.name) {
                    allEntityNames.add(e.name.trim());
                  }
                }
              }

              const entityList = Array.from(allEntityNames);

              if (entityList.length > 0) {
                // 3. Define structured output schema for the alignment map
                const alignmentSchema = z.object({
                  mappings: z
                    .array(
                      z.object({
                        original: z
                          .string()
                          .describe("The original entity name variation found in the list"),
                        canonical: z
                          .string()
                          .describe("The resolved canonical standard name to merge into"),
                      }),
                    )
                    .describe("A list of name mappings to resolve aliases and variants"),
                });

                const systemMsg = new SystemMessage(KB_ENTITY_ALIGNMENT_SYSTEM_PROMPT);
                const humanMsg = new HumanMessage(
                  `Document Title: ${doc.title || "Unknown Document"}\n` +
                    `Extracted Entities List:\n${JSON.stringify(entityList, null, 2)}`,
                );

                // 4. Call LLM to find alignments
                const alignmentResult = (await extractModel
                  .withStructuredOutput(alignmentSchema, { method: "jsonSchema" })
                  .invoke([systemMsg, humanMsg], { ...config, tags: ["nostream"] })) as z.infer<
                  typeof alignmentSchema
                >;

                // 5. Create mapping dictionary
                const nameMap = new Map<string, string>();
                if (alignmentResult?.mappings) {
                  for (const m of alignmentResult.mappings) {
                    const orig = m.original.trim();
                    const canon = m.canonical.trim();
                    if (orig && canon && orig !== canon) {
                      nameMap.set(orig.toLowerCase(), canon);
                    }
                  }
                }

                // 6. Update database if any mappings found
                if (nameMap.size > 0) {
                  for (const c of successChunks) {
                    let chunkUpdated = false;

                    // Standardize entities list
                    const updatedEntities = (c.entities ?? []).map((e) => {
                      const match = nameMap.get(e.name.trim().toLowerCase());
                      if (match) {
                        chunkUpdated = true;
                        return { ...e, name: match };
                      }
                      return e;
                    });

                    // Standardize relationships list
                    const updatedRelationships = (c.relationships ?? []).map((r) => {
                      let relUpdated = false;
                      let source = r.source;
                      let target = r.target;

                      const matchSrc = nameMap.get(r.source.trim().toLowerCase());
                      if (matchSrc) {
                        source = matchSrc;
                        relUpdated = true;
                      }
                      const matchTgt = nameMap.get(r.target.trim().toLowerCase());
                      if (matchTgt) {
                        target = matchTgt;
                        relUpdated = true;
                      }

                      if (relUpdated) {
                        chunkUpdated = true;
                        return { ...r, source, target };
                      }
                      return r;
                    });

                    // Write-back to DB if this chunk had aligned elements
                    if (chunkUpdated) {
                      await updateKbChunkGraphData(c.id, updatedEntities, updatedRelationships);
                    }
                  }
                }
              }
            } catch (alignErr) {
              console.error(
                `kbAgent generateChunkEmbedNode: entity alignment failed for doc ${docId}:`,
                alignErr,
              );
            }

            invalidateKbDoc(userId, docId);
          } catch (err) {
            // ponytail: WHOLE-batch failure (embedding dim mismatch,
            // DB write rejection). kb_document.status stays at
            // 'success' (it was flipped by imageToMarkdownNode) —
            // chunks are a downstream derived store, and a chunk
            // pipeline crash shouldn't downgrade the doc itself.
            // The Settings UI surfaces "0/47 chunks indexed" via
            // the chunk count roll-up, and the user can rebuild
            // chunks via Reprocess > "Only rebuild chunks".
            const pgErr = err as Error & {
              code?: string;
              detail?: string;
              hint?: string;
            };
            const reason = pgErr.code
              ? `${pgErr.code}: ${pgErr.detail ?? pgErr.message}${pgErr.hint ? ` (${pgErr.hint})` : ""}`
              : pgErr.message;
            console.error(
              `kbAgent generateChunkEmbedNode: batch failure for doc ${docId}: ${reason}`,
              pgErr,
            );
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

function routeAfterRewrite(state: KbAgentStateShape): string | typeof END {
  const hasNew = state.processedFiles.some((p) => p.pipelineStatus === "new");
  console.log(
    `[kbAgent] routeAfterRewrite: hasNew=${hasNew}, files=`,
    state.processedFiles.map((p) => ({ docId: p.docId, status: p.pipelineStatus })),
  );
  if (hasNew) {
    console.log(`[kbAgent] Routing to generateChunkEmbed`);
    return "generateChunkEmbed";
  }
  console.log(`[kbAgent] Routing to END`);
  return END;
}

const builder = new StateGraph(KbAgentState)
  .addNode("prepareKBData", prepareKBDataNode)
  .addNode("splitFilePage", splitFileToPageNode)
  .addNode("pageToMarkdown", pageToMarkdownNode)
  .addNode("rewriteMessages", rewriteMessagesNode)
  .addNode("generateChunkEmbed", generateChunkEmbedNode)
  .addEdge(START, "prepareKBData")
  .addEdge("prepareKBData", "splitFilePage")
  .addEdge("splitFilePage", "pageToMarkdown")
  .addEdge("pageToMarkdown", "rewriteMessages")
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
  callbacks: [
    // capturing is related thread list, now is unavailable
    // capturingHandler,
    creditTrackingHandler,
  ],
});
void END;
