import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import PQueue from "p-queue";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { getChatModel, getEmbeddingModel, getVlmModel } from "@/backend/model";
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
  type KbDocument,
} from "@/lib/kb/queries";
import { findAttachmentByR2Key } from "@/lib/attachments/queries";
import { appendKbRef, extractFilePart, findLastHumanMessage } from "@/lib/kb/extract";
import { invalidateKbDoc } from "@/lib/kb/cache";
import { r2KeyFromPublicUrl, uploadKbImage, getR2PublicBaseUrl, getObject } from "@/lib/r2/client";

// ponytail: v2 KB ingest subgraph. Compiled once at module load, then
// wired into the parent agent.ts graph as `kbAgent`. Sits between
// RouterNode (which decides "PDF → kbAgent") and the actual sub-agent
// (chatAgent / etc.). The parent calls `addEdge("kbAgent", "routerAgent")`
// so the router runs a SECOND time after kbAgent, this time seeing the
// appended kb_ref — and routes to chatAgent (no more PDF to handle).
//
// Flow:
//   START → screenshot → (conditional) → chunkEmbedStore → END
//                              ↓
//                            vlm ────────────┘
//
// The conditional edge after screenshotNode skips vlm + chunkEmbedStore
// when the doc is a dedup hit (state.skipPipeline). Both the dedup-hit
// path and the new-ingest path funnel through chunkEmbedStoreNode
// (which appends the kb_ref to the last HumanMessage either way).

type PageResult = {
  pageIndex: number;
  imageUrl: string;
  markdown: string;
};
type ChunkSeed = { ordinal: number; content: string; entities: string[]; embedding: number[] };

// ponytail: withStructuredOutput forces the VLM to emit {markdown:
// string}. The system prompt (KB_OCR_PAGE_PROMPT) gives the WHAT —
// "you are extracting markdown from a PDF page". The schema's
// .describe() gives the JSON-side instruction (same prose, structured
// for the parser) and removes the "empty markdown" footgun — every
// response is guaranteed to be either a string or a thrown parse
// error. Replaces the prior string|array|"" shape-detection branch.
const vlmPageSchema = z.object({
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
  attachmentId: z.string().nullable().default(null),
  r2Key: z.string().nullable().default(null),
  title: z.string().nullable().default(null),
  contentHash: z.string().nullable().default(null),
  docId: z.string().nullable().default(null),
  // Internal.
  pages: z.array(z.custom<PageResult>()).default([]),
  skipPipeline: z.boolean().default(false),
  chunks: z.array(z.custom<ChunkSeed>()).default([]),
  status: z.enum(["pending", "parsing", "success", "failed"]).default("pending"),
  errorMessage: z.string().nullable().default(null),
});

function makeError(message: string) {
  return { status: "failed" as const, errorMessage: message, skipPipeline: true };
}

// ponytail: derive the state shape once and reuse; matches the pattern
// in chat-agent.ts (inline `messages: BaseMessage[]`).
type KbAgentStateShape = {
  messages: BaseMessage[];
  userId: string | null;
  attachmentId: string | null;
  r2Key: string | null;
  title: string | null;
  contentHash: string | null;
  docId: string | null;
  pages: PageResult[];
  skipPipeline: boolean;
  chunks: ChunkSeed[];
  status: "pending" | "parsing" | "success" | "failed";
  errorMessage: string | null;
};

async function screenshotNode(
  state: KbAgentStateShape,
  config?: { configurable?: { userId?: string } },
): Promise<Partial<KbAgentStateShape>> {
  const userId = config?.configurable?.userId ?? state.userId;

  if (!userId) return makeError("user not provided");
  const last = findLastHumanMessage(state.messages);
  if (!last) return makeError("no human message");
  const filePart = extractFilePart(state.messages);
  if (!filePart) return makeError("no file part");
  if (filePart.mime_type !== "application/pdf") {
    return makeError(`unsupported type: ${filePart.mime_type ?? "unknown"}`);
  }
  const base = getR2PublicBaseUrl();
  const r2Key = r2KeyFromPublicUrl(filePart.data, base);
  const attachment = await findAttachmentByR2Key(userId, r2Key);
  if (!attachment) return makeError("attachment not found");

  const contentHash = attachment.sha256 ?? `r2key:${attachment.r2Key}`;

  // PRIMARY dedup — contentHash. SECONDARY — attachmentId (defense in
  // depth). Either hit short-circuits to a kb_ref-only pass.
  let existing = await findKbDocumentByContentHash(userId, contentHash);
  if (!existing) existing = await findKbDocumentByAttachmentId(userId, attachment.id);

  if (existing) {
    return {
      userId,
      attachmentId: attachment.id,
      r2Key: attachment.r2Key,
      title: attachment.name,
      contentHash,
      docId: existing.id,
      status: existing.status as KbAgentStateShape["status"],
      errorMessage: existing.errorMessage,
      skipPipeline: true,
    };
  }

  // New ingest: fetch bytes, render pages, upload to R2.
  const pdfBytes = await getObject(attachment.r2Key);
  const rendered = await screenshotPdf({ pdfBytes, dpi: 200 });
  const docId = `d-${randomUUID()}`;
  const pages: PageResult[] = await Promise.all(
    rendered.map(async (p) => {
      const key = `kb-tmp/${userId}/${docId}/page-${p.pageIndex}.png`;
      const imageUrl = await uploadKbImage({ key, body: p.png });
      return { pageIndex: p.pageIndex, imageUrl, markdown: "" };
    }),
  );

  return {
    userId,
    attachmentId: attachment.id,
    r2Key: attachment.r2Key,
    title: attachment.name,
    contentHash,
    docId,
    pages,
    status: "parsing",
  };
}

// ponytail: cap VLM concurrency at 5 to stay under apimart's per-key
// rate limit. A 30-page PDF otherwise fires 30 simultaneous requests.
// Order is preserved by Promise.all — pages[i] always maps to results[i].
const VLM_CONCURRENCY = 5;

async function vlmNode(state: KbAgentStateShape) {
  if (state.skipPipeline) return {};
  const vlm = await getVlmModel();
  const queue = new PQueue({ concurrency: VLM_CONCURRENCY });
  // ponytail: hoist the system message + structured binding out of the
  // per-page loop — every page shares the same prompt + schema. The
  // page image is the only per-call variable, so it lives in the
  // HumanMessage. withStructuredOutput guarantees `out.markdown` is a
  // string (or the call throws), so no shape-detection branch below.
  const system = new SystemMessage(KB_OCR_PAGE_PROMPT);
  const structured = vlm.withStructuredOutput(vlmPageSchema, { method: "jsonSchema" });
  try {
    const results = await Promise.all(
      state.pages.map((p) =>
        queue.add(async () => {
          // ponytail: pass the R2 publicUrl directly — no base64
          // round-trip. Keeps state.pages as just URL strings, not
          // PNG Buffers. LangChain translates {type:image_url} into the
          // OpenAI chat-completions shape the upstream expects.
          const user = new HumanMessage({
            content: [{ type: "image_url", image_url: { url: p.imageUrl } }],
          });
          const out = await structured.invoke([system, user], { tags: ["nostream"] });
          return { ...p, markdown: out.markdown.trim() };
        }),
      ),
    );
    return { pages: results };
  } catch (err) {
    // ponytail: Promise.all rejects on the first page failure; p-queue
    // can't cancel in-flight jobs, but their results are discarded.
    return {
      status: "failed" as const,
      errorMessage: (err as Error).message,
      skipPipeline: true,
    };
  }
}

async function chunkEmbedStoreNode(state: KbAgentStateShape) {
  const userId = state.userId;
  const docId = state.docId;
  const attachmentId = state.attachmentId;
  const contentHash = state.contentHash;
  if (!userId || !docId || !contentHash || !attachmentId) {
    return { status: "failed" as const, errorMessage: "missing fields in kbAgent state" };
  }

  // ponytail: append the kb_ref up-front (before any success/failure
  // branch below). The router's next pass keys off filePart vs kb_ref
  // — if we don't land a kb_ref in state.messages, the parent loops
  // kbAgent forever (router short-circuit sees filePart still present
  // and re-routes here). The old code only appended kb_ref on the
  // success + skipPipeline branches, missing the "empty markdown after
  // VLM" failure path. Doc status can still be "failed" — the UI shows
  // it as Failed and the user can retry — but the loop must end.
  const last = findLastHumanMessage(state.messages);
  if (!last) return { status: "failed" as const, errorMessage: "no human message" };
  const rewritten = appendKbRef(state.messages, docId, attachmentId);

  // Skip-path (dedup hit or vlm failed): no new chunks — bail.
  if (state.skipPipeline) {
    return { messages: rewritten, status: state.status, errorMessage: state.errorMessage };
  }

  // New ingest: chunk + embed + entity extract + DB transaction.
  const fullMarkdown = state.pages
    .map((p) => p.markdown)
    .filter((m) => m.length > 0)
    .join("\n\n");
  if (!fullMarkdown) {
    return {
      messages: rewritten,
      status: "failed" as const,
      errorMessage: "empty markdown after VLM",
    };
  }
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 200 });
  const splitDocs = await splitter.createDocuments([fullMarkdown]);
  const chat = await getChatModel();

  // Entity extraction per chunk (best-effort — fall back to [] on parse).
  // ponytail: same p-queue pattern as vlmNode — serial would be 30 chunks
  // × ~2s = 60s of LLM calls on a 30-page PDF. Cap at 5 to stay under
  // apimart's per-key rate limit.
  const entitySchema = z.array(z.string());
  const embedder = await getEmbeddingModel();
  const texts = splitDocs.map((d) => d.pageContent);
  const embeddings = await embedder.embedDocuments(texts);
  const entityQueue = new PQueue({ concurrency: 5 });
  const seeds: ChunkSeed[] = await Promise.all(
    texts.map((text, i) =>
      entityQueue.add(async () => {
        let entities: string[] = [];
        try {
          const out = await chat
            .withStructuredOutput(entitySchema)
            .invoke(
              `Extract named entities (people, orgs, concepts, products) from this passage:\n\n${text}`,
            );
          entities = (out as string[]).slice(0, 20);
        } catch {
          // best-effort — leave entities empty and continue
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

  // tx: doc + chunks land atomically.
  const folder = await ensureDefaultKbFolder(userId, "Attachments");
  const newDoc: KbDocument = await withKbTx(async (tx) => {
    const doc = await insertKbDocument({
      id: docId,
      userId,
      folderId: folder.id,
      attachmentId,
      title: state.title ?? "untitled",
      contentType: "application/pdf",
      contentHash,
      status: "success",
      errorMessage: null,
    });
    // ponytail: tsv is a generated column — passing any value trips
    // Postgres' "cannot insert a non-DEFAULT value into column tsv"
    // (428C9). Cast through `unknown` to drop the tsv field that Drizzle
    // infers as required on the insert type.
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
    return doc;
  });
  invalidateKbDoc(userId, newDoc.id);

  // `rewritten` (with the new docId) was already computed up-front —
  // it carries docId from state, which IS newDoc.id at this point.
  return { chunks: seeds, messages: rewritten, status: "success", errorMessage: null };
}

function routeAfterScreenshot(state: KbAgentStateShape): "vlm" | "chunkEmbedStore" {
  return state.skipPipeline ? "chunkEmbedStore" : "vlm";
}

const builder = new StateGraph(KbAgentState)
  .addNode("screenshot", screenshotNode)
  .addNode("vlm", vlmNode)
  .addNode("chunkEmbedStore", chunkEmbedStoreNode)
  .addEdge(START, "screenshot")
  .addConditionalEdges("screenshot", routeAfterScreenshot, ["vlm", "chunkEmbedStore"])
  .addEdge("vlm", "chunkEmbedStore")
  .addEdge("chunkEmbedStore", END);

export const kbAgent = builder.compile({
  name: "kbAgent",
  ...subgraphCheckpointerConfig,
});
void END;
