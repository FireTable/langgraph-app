import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { getEmbeddingModel, getVlmModel } from "@/backend/model";
import { screenshotPdf } from "@/lib/kb/screenshot";
import {
  writeKbDoc,
  type KbChunkRecord,
  type KbDocRecord,
  type KbPageRecord,
} from "@/lib/kb/store";

/**
 * Ponytail: v1 KB ingestion subgraph. Three nodes — screenshot → vlm →
 * chunk-embed-store — wired linearly. Each node updates a shared
 * KbAgentState; the final node writes the JSON record so a v2 migration
 * to Postgres is a 1:1 dump.
 *
 * The graph is invoked synchronously from the chat runtime's
 * attachment-kb-injector node (commit #5). For v1 we don't need a
 * background dispatcher — the chat blocks on this subgraph for the
 * first message that touches a new attachment, matching the M2
 * transition plan's UX option (c) (sync fallback, duplicate work on
 * the first turn only).
 *
 * v2 will move this to background: fire-and-forget invoke from
 * confirm/route.ts (#12), the chat model sees the original file part
 * for the first turn, and the model gets KB chunks on subsequent
 * turns once the subgraph finishes.
 */

const KbAgentState = new StateSchema({
  userId: z.string(),
  attachmentId: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  title: z.string(),
  contentType: z.string(),
  contentHash: z.string(),
  pdfBytes: z.instanceof(Buffer),
  docId: z.string(),
  imageTmpDir: z.string().nullable(),
  pages: z
    .array(
      z.object({
        pageIndex: z.number(),
        markdown: z.string(),
        imagePath: z.string(),
      }),
    )
    .default([]),
  chunks: z
    .array(
      z.object({
        id: z.string(),
        ordinal: z.number(),
        content: z.string(),
        embedding: z.array(z.number()),
        entities: z.array(z.string()),
      }),
    )
    .default([]),
  status: z.enum(["pending", "parsing", "ready", "failed"]).default("pending"),
  errorMessage: z.string().nullable().default(null),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

// ponytail: VLM is called per page with the rendered PNG. The prompt
// asks for clean markdown so the chunker's downstream step (or v1's
// 1-page = 1-chunk shortcut) gets a predictable input shape. Trimming
// whitespace is the model's job; we don't re-parse.
const VLM_PAGE_PROMPT = `You are extracting text from a single PDF page rendered as an image.
Output clean markdown: preserve headings, lists, code blocks, tables, and inline formatting.
If the page is blank or contains only decorative images, output an empty string.
Do not add commentary — return only the markdown content of the page.`;

async function screenshotNode(state: typeof KbAgentState.State) {
  // ponytail: mupdf needs a writable dir. Use the caller-provided
  // imageTmpDir (set by tests) when present, otherwise mkdtemp under
  // os.tmpdir(). Tests pre-create the dir via mkdtempSync; production
  // path uses the async mkdtemp here. The dir lives only for the
  // duration of the subgraph; chunkEmbedStoreNode reads from imagePath
  // then runs cleanup.
  let dir: string;
  if (state.imageTmpDir) {
    dir = state.imageTmpDir;
    await mkdir(dir, { recursive: true });
  } else {
    dir = await mkdtemp(join(tmpdir(), "kb-screenshot-"));
  }
  const pdfBytes = Buffer.from(state.pdfBytes);
  const pages = await screenshotPdf({ pdfBytes, outputDir: dir, dpi: 200 });
  return {
    pages: pages.map((p: { pageIndex: number; imagePath: string }) => ({
      pageIndex: p.pageIndex,
      imagePath: p.imagePath,
      markdown: "",
    })),
    imageTmpDir: dir,
    status: "parsing" as const,
  };
}

async function vlmNode(state: typeof KbAgentState.State) {
  const vlm = await getVlmModel();
  const updatedPages: KbPageRecord[] = [];
  try {
    for (const p of state.pages) {
      // ponytail: ChatOpenAI's image_url content part accepts a data: URL
      // or an http(s) URL. We send a data URL with base64 so the model
      // can OCR the image inline. v2 will swap to R2-hosted URLs to keep
      // payload sizes sane for large documents.
      const imgBytes = await readFile(p.imagePath);
      const dataUrl = `data:image/png;base64,${Buffer.from(imgBytes).toString("base64")}`;
      const response = await vlm.invoke([
        {
          role: "user",
          content: [
            { type: "text", text: VLM_PAGE_PROMPT },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ] as never);
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
      updatedPages.push({
        pageIndex: p.pageIndex,
        imagePath: p.imagePath,
        markdown: text.trim(),
      });
    }
    return { pages: updatedPages };
  } catch (err) {
    // ponytail: bubble up as status=failed + errorMessage in state, not
    // as a thrown error. The chat runtime's attachment-kb-injector
    // (commit #5) inspects state.status to decide whether to short-
    // circuit the chat loop. Throwing would crash the LangGraph run.
    return {
      status: "failed" as const,
      errorMessage: (err as Error).message,
    };
  }
}

async function chunkEmbedStoreNode(state: typeof KbAgentState.State) {
  // ponytail: v1 chunks 1:1 with pages. A page's VLM output is one
  // chunk. Future: replace with chonkie/LangChain Recursive splitter
  // when we need semantic boundaries. The store already carries
  // `chunks: KbChunkRecord[]` so the schema doesn't change.
  //
  // Failure short-circuit: if vlmNode already set status=failed (e.g.
  // VLM call errored), we still write a partial record to the store
  // so the user can see what failed in their KB. No embeddings → empty
  // chunks array, status=failed with errorMessage propagated.
  const embedder = await getEmbeddingModel();
  const isFailed = state.status === "failed";
  const nonEmpty = isFailed
    ? []
    : state.pages.filter((p: { markdown: string }) => p.markdown.length > 0);
  const texts = nonEmpty.map((p: { markdown: string }) => p.markdown);
  const embeddings: number[][] = texts.length > 0 ? await embedder.embedDocuments(texts) : [];

  const chunks: KbChunkRecord[] = nonEmpty.map((p: { markdown: string }, i: number) => ({
    id: `c-${randomUUID()}`,
    ordinal: i,
    content: p.markdown,
    embedding: embeddings[i] ?? [],
    // ponytail: entity extraction is v2. v1 leaves the field empty; the
    // search-graph leg in issue #13's design gets activated once
    // entity extraction lands.
    entities: [],
  }));

  const now = new Date().toISOString();
  const record: KbDocRecord = {
    id: state.docId,
    userId: state.userId,
    attachmentId: state.attachmentId,
    sourceUrl: state.sourceUrl,
    title: state.title,
    contentType: state.contentType,
    status: isFailed ? "failed" : "ready",
    contentHash: state.contentHash,
    errorMessage: state.errorMessage,
    pages: state.pages,
    chunks,
    createdAt: state.createdAt ?? now,
    updatedAt: now,
  };
  await writeKbDoc(record);

  // ponytail: image tmp dir is no longer needed once chunks are stored;
  // the JSON record's imagePath points into it, but v1 doesn't expose
  // those paths in the UI yet. Clean up to avoid leaking the rendered
  // PNGs forever. v2 keeps the images in R2.
  if (state.imageTmpDir) {
    try {
      await rm(state.imageTmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; tmp OS reaps eventually
    }
  }

  return {
    chunks,
    status: isFailed ? ("failed" as const) : ("ready" as const),
    errorMessage: state.errorMessage,
    updatedAt: now,
  };
}

const builder = new StateGraph(KbAgentState)
  .addNode("screenshot", screenshotNode)
  .addNode("vlm", vlmNode)
  .addNode("chunkEmbedStore", chunkEmbedStoreNode)
  .addEdge(START, "screenshot")
  .addEdge("screenshot", "vlm")
  .addEdge("vlm", "chunkEmbedStore")
  .addEdge("chunkEmbedStore", END);

export const graph = builder.compile({ name: "kbAgent" });
