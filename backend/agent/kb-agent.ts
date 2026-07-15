import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import PQueue from "p-queue";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { getChatModel, getEmbeddingModel, getOcrModel } from "@/backend/model";
import { KB_OCR_PAGE_PROMPT } from "@/backend/prompt/system";
import { subgraphCheckpointerConfig } from "@/backend/checkpointer";
import { screenshotPdf } from "@/lib/kb/screenshot";
import {
  ensureDefaultKbFolder,
  findKbDocumentByContentHash,
  findKbDocumentByAttachmentId,
  insertKbChunks,
  insertKbDocument,
  withKbTx,
} from "@/lib/kb/queries";
import { findAttachmentByR2Key } from "@/lib/attachments/queries";
import { extractAllPdfParts, isFilePart, isKbRefPart, type FilePart } from "@/lib/kb/extract";
import { invalidateKbDoc } from "@/lib/kb/cache";
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
//   1. kb_ref appended to its HumanMessage (success, dedup, or
//      [Processing...]/[Failed: ...] placeholders resolved later by
//      trimMessagesForInvoke → resolveKbRefs).
//   2. file part stripped (unknown attachment, can't even dedup).
//   3. carried over as a non-PDF file (images etc. — preserved).
//
// No skipPipeline state. After one kbAgent invocation there are zero
// PDF file parts left in state.messages; every PDF has been either
// ingested or stripped. The router's second pass routes to a chat
// sub-agent cleanly.

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
  //            exist in DB — resolve layer shows [Failed: ...] or
  //            strips the kb_ref.
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
  // with no docId, kbAgent still appends a kb_ref or strips cleanly.
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
      // ponytail: render failure flips this PDF to "failed" — it'll
      // get a kb_ref with no docId, resolve layer strips it. We keep
      // the rest of the batch intact.
      pf.pipelineStatus = "failed";
      pf.docId = null;
      pf.errorMessage = (err as Error).message;
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
      const idx = state.processedFiles.indexOf(pf);
      if (idx >= 0) {
        updatedProcessed[idx] = {
          ...updatedProcessed[idx],
          pipelineStatus: "failed",
          docId: null,
          errorMessage: (r.reason as Error).message,
        };
      }
    }
  });

  return { pagesByDocId: updatedPagesByDocId, processedFiles: updatedProcessed };
}

async function chunkEmbedStoreNode(state: KbAgentStateShape) {
  const userId = state.userId;
  if (!userId) return { status: "failed" as const, errorMessage: "no userId" };

  const folder = await ensureDefaultKbFolder(userId, "Attachments");

  // ponytail: per-doc chunk + embed + entity extract. Process all new
  // docs in parallel — each is independent. Failure of one doc flips
  // that entry to "failed" and we continue.
  const newDocs = state.processedFiles.filter(
    (p) => p.pipelineStatus === "new" && p.docId !== null,
  );

  const chat = await getChatModel();
  const entitySchema = z.array(z.string());
  const embedder = await getEmbeddingModel();
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 200 });
  const entityQueue = new PQueue({ concurrency: ENTITY_CONCURRENCY });

  const updatedChunksByDocId: Record<string, ChunkSeed[]> = { ...state.chunksByDocId };
  const updatedProcessed = state.processedFiles.map((p) => ({ ...p }));

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
            docId: null,
            errorMessage: "empty markdown after OCR",
          };
        }
        return;
      }

      try {
        const splitDocs = await splitter.createDocuments([fullMarkdown]);
        const texts = splitDocs.map((d) => d.pageContent);
        const embeddings = await embedder.embedDocuments(texts);
        const seeds: ChunkSeed[] = await Promise.all(
          texts.map((text, i) =>
            entityQueue.add(async (): Promise<ChunkSeed> => {
              let entities: string[] = [];
              try {
                const out = await chat
                  .withStructuredOutput(entitySchema)
                  .invoke(
                    `Extract named entities (people, orgs, concepts, products) from this passage:\n\n${text}`,
                  );
                entities = (out as string[]).slice(0, 20);
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
          const doc = await insertKbDocument({
            id: docId,
            userId,
            folderId: folder.id,
            attachmentId: pf.attachmentId!,
            title: pf.title ?? "untitled",
            contentType: "application/pdf",
            contentHash: pf.contentHash!,
            status: "success",
            errorMessage: null,
          });
          await insertKbChunks(
            tx,
            seeds.map((s) => ({
              id: `c-${randomUUID()}`,
              documentId: doc.id,
              ordinal: s.ordinal,
              content: s.content,
              embedding: s.embedding,
              entities: s.entities,
            })) as never,
          );
        });
        invalidateKbDoc(userId, docId);
        updatedChunksByDocId[docId] = seeds;
      } catch (err) {
        const idx = state.processedFiles.indexOf(pf);
        if (idx >= 0) {
          updatedProcessed[idx] = {
            ...updatedProcessed[idx],
            pipelineStatus: "failed",
            docId: null,
            errorMessage: (err as Error).message,
          };
        }
      }
    }),
  );

  // ponytail: rewrite EVERY HumanMessage that had a PDF file part.
  // Each PDF file part → kb_ref (if we have a docId) OR strip (if
  // unknown/failed with no docId). Text parts and existing kb_ref
  // parts preserved. Non-PDF file parts dropped (consistent with
  // the prior appendKbRef behavior — they were never surfaced to
  // the model anyway).
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
      if (isKbRefPart(part)) {
        // keep existing kb_refs — they came from a prior kbAgent run
        newContent.push(part);
        continue;
      }
      if (isFilePart(part)) {
        changed = true;
        const matched = fileToDoc.get(part.data);
        if (matched) {
          newContent.push({
            type: "kb_ref",
            docId: matched.docId,
            attachmentId: matched.attachmentId ?? undefined,
          });
        }
        // unmatched (non-PDF or unknown PDF) → drop
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

export const kbAgent = builder.compile({
  name: "kbAgent",
  ...subgraphCheckpointerConfig,
});
void END;
