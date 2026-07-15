import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { type BaseMessage } from "@langchain/core/messages";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import PQueue from "p-queue";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { getChatModel, getEmbeddingModel, getVlmModel } from "@/backend/model";
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

const VLM_PAGE_PROMPT = `You are extracting text from a single PDF page rendered as an image.
Output clean markdown: preserve headings, lists, code blocks, tables, and inline formatting.
If the page is blank or contains only decorative images, output an empty string.
Do not add commentary — return only the markdown content of the page.`;

type PageResult = {
  pageIndex: number;
  imageUrl: string;
  markdown: string;
};
type ChunkSeed = { ordinal: number; content: string; entities: string[]; embedding: number[] };

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
  try {
    const results = await Promise.all(
      state.pages.map((p) =>
        queue.add(async () => {
          // ponytail: apimart accepts the assistant-ui image part shape
          // (same one r2-adapter.ts uses for chat uploads) — pass the
          // R2 publicUrl directly, no base64 round-trip. Also keeps
          // state tiny: just the URL string, not the PNG Buffer.
          const filename = state.title ?? "page";
          const response = await vlm.invoke(
            [
              {
                role: "user",
                content: [
                  { type: "text", text: VLM_PAGE_PROMPT },
                  {
                    type: "image",
                    image: p.imageUrl,
                    filename,
                  },
                ],
              },
            ] as never,
            { tags: ["nostream"] },
          );
          const content = response.content;
          const text =
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content
                    .map((c: unknown) =>
                      typeof c === "object" && c !== null && "text" in c
                        ? (c as { text: string }).text
                        : "",
                    )
                    .join("")
                : "";
          return { ...p, markdown: text.trim() };
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

  // Skip-path (dedup hit or vlm failed): no new chunks — append kb_ref
  // for the existing doc and bail.
  if (state.skipPipeline) {
    const last = findLastHumanMessage(state.messages);
    if (!last) return { status: "failed" as const, errorMessage: "no human message" };
    const rewritten = appendKbRef(state.messages, docId, attachmentId);
    return { messages: rewritten, status: state.status, errorMessage: state.errorMessage };
  }

  // New ingest: chunk + embed + entity extract + DB transaction.
  const fullMarkdown = state.pages
    .map((p) => p.markdown)
    .filter((m) => m.length > 0)
    .join("\n\n");
  if (!fullMarkdown) {
    return { status: "failed" as const, errorMessage: "empty markdown after VLM" };
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

  const last = findLastHumanMessage(state.messages);
  if (!last) return { status: "failed" as const, errorMessage: "no human message" };
  const rewritten = appendKbRef(state.messages, newDoc.id, attachmentId);
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
