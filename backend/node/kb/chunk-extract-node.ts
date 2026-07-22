import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { MarkdownTextSplitter } from "@langchain/textsplitters";
import PQueue from "p-queue";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { KbAgentStateShape } from "@/backend/state";
import { getExtractModel } from "@/backend/model";
import { KB_ENTITY_EXTRACTION_SYSTEM_PROMPT } from "@/backend/prompt/system";
import {
  findKbDocumentById,
  findKbChunksByDocumentId,
  insertKbChunks,
  markAllKbChunksParsingForDocInTx,
  markKbChunkFailed,
  markKbChunkSuccess,
  replaceChunkThemes,
  updateKbChunkForFailure,
  upsertKbEntity,
  upsertKbRelationship,
  withKbTx,
} from "@/lib/kb/queries";
import { invalidateKbDoc } from "@/lib/kb/cache";
import { appLevelCanonical } from "@/lib/kb/canonical";
import { KB_ENTITY_CONCURRENCY } from "@/lib/constants";

const KB_CHUNK_SIZE = 1024;
const KB_CHUNK_OVERLAP = 200;
const SKIP_CHUNK_TO_ENTRIES = false;

export const graphRagSchema = z
  .object({
    entities: z
      .array(
        z.object({
          name: z
            .string()
            .describe("Unique name of the extracted entity in its canonical surface form"),
          type: z
            .string()
            .describe(
              "Category or classification of entity (e.g. Person, Organization, Location, Concept, Technology)",
            ),
          description: z
            .string()
            .describe(
              "Comprehensive summary of the entity's attributes, role, and context in this chunk",
            ),
        }),
      )
      .describe("Extracted key entities appearing in this text chunk"),
    relationships: z
      .array(
        z.object({
          source: z
            .string()
            .describe(
              "Source entity name; MUST correspond to one of the extracted entities in the entities array",
            ),
          target: z
            .string()
            .describe(
              "Target entity name; MUST correspond to one of the extracted entities in the entities array",
            ),
          relation: z
            .string()
            .describe(
              "Directed relationship label connecting source to target (e.g. PARTNERED_WITH, USES, FOUNDED_BY)",
            ),
          description: z
            .string()
            .describe(
              "Explanation of the relationship and how the source and target interact in this chunk",
            ),
        }),
      )
      .describe(
        "Directed relationships connecting the extracted entities in this chunk. Every relationship must link valid entities from the entities list so no isolated entity nodes remain without graph connections.",
      ),
    themes: z
      .array(z.string())
      .describe(
        "Macroscopic abstractions or top-level topics summarizing the main intent, domain, and concepts of this chunk",
      ),
  })
  .describe(
    "Structured GraphRAG extraction result containing entities, directed relationships connecting them, and macro themes",
  );

export function normalizeGraphRagOut(out: Partial<z.infer<typeof graphRagSchema>>) {
  // ponytail: per-chunk top-level themes live flat on kb_theme
  // (single source of truth — no fan-out into kb_entity / kb_relationship).
  // We return them as a separate `themes` field; the caller writes
  // them via replaceChunkThemes AFTER the entity / relationship
  // upserts so chunk-without-entities still carries its macro topics.
  const chunkThemes = Array.from(
    new Set((out.themes ?? []).map((t) => t.trim()).filter((t) => t.length > 0)),
  );

  const normEnt = (out.entities ?? []).map((e) => ({
    name: e.name.trim(),
    type: e.type.trim(),
    description: e.description.trim(),
  }));
  const normRel = (out.relationships ?? []).map((r) => ({
    source: r.source.trim(),
    target: r.target.trim(),
    relation: r.relation.trim(),
    description: r.description.trim(),
  }));

  const map = new Map<string, (typeof normEnt)[number]>();
  for (const e of normEnt) {
    if (!e.name) continue;
    const k = `${e.name.toLowerCase()}::${e.type.toLowerCase()}`;
    const cur = map.get(k);
    if (!cur) {
      map.set(k, e);
    } else {
      const mergedDesc = [cur.description, e.description].filter((d) => d.length > 0).join("; ");
      map.set(k, { ...cur, description: mergedDesc });
    }
  }

  const relMap = new Map<string, (typeof normRel)[number]>();
  for (const r of normRel) {
    if (!r.source || !r.target || !r.relation) continue;
    const k = `${r.source.toLowerCase()}::${r.relation.toLowerCase()}::${r.target.toLowerCase()}`;
    const cur = relMap.get(k);
    if (!cur) {
      relMap.set(k, r);
    } else {
      const mergedDesc = [cur.description, r.description].filter((d) => d.length > 0).join("; ");
      relMap.set(k, { ...cur, description: mergedDesc });
    }
  }

  return {
    entities: Array.from(map.values()),
    relationships: Array.from(relMap.values()),
    themes: chunkThemes,
  };
}

// ponytail: forward-merge orphan horizontal-rule chunks. officeparser
// emits `\n---\n` between sheets/slides/pages; LangChain's
// MarkdownTextSplitter treats `---` as a paragraph break, so when a
// sheet is long enough to hit `chunkSize` the splitter cuts AT the `---`
// and the rule becomes its own chunk. Embedding `---` alone is
// meaningless (1 token, ~0 signal) and a dedicated chunk wastes an id
// + slot in the UI. Merge forward into the next chunk's head — the
// `---` becomes a ~1-token prefix that gets averaged into the real
// embedding and adds no recall cost. Trailing orphans (no successor)
// are dropped: rare, and the doc already lacks content past that
// point. Exported so tests can pin the behavior without spinning up
// the whole node.
//
// Algorithm: peek-forward. Collect consecutive HR-only chunks into a
// `pendingHr` buffer; when the next non-HR chunk arrives, prepend the
// buffer (joined with blank lines) to that chunk's head. Buffer that
// never gets flushed (trailing HRs or all-HR input) is dropped.
// This avoids the in-place mutation hazard of a right-to-left pass
// (where a merged chunk that no longer trim()-equals `"---"` would be
// wrongly classified on its own re-visit).
export function mergeHrOnlyChunks(texts: string[]): string[] {
  const out: string[] = [];
  let pendingHr: string[] = [];

  for (const t of texts) {
    const isHrOnly = t.trim() === "---";
    if (isHrOnly) {
      pendingHr.push(t.trim());
    } else if (pendingHr.length > 0) {
      const prefix = pendingHr.join("\n\n");
      out.push(`${prefix}\n\n${t}`.trim());
      pendingHr = [];
    } else {
      out.push(t);
    }
  }
  // ponytail: trailing HR-only chunks have no successor — drop.
  return out;
}

export async function chunkExtractNode(
  state: KbAgentStateShape,
  config?: RunnableConfig,
): Promise<Partial<KbAgentStateShape>> {
  const extractedChunkIds: string[] = [];

  if (state.userId) {
    // ponytail: chunksEmbedAgent wraps this node + alignment + embed
    // into a single sub-graph; parent kbAgent gates ingestion via
    // `routeAfterRewrite` (only enters when at least one processed
    // file is `new`). The IIFE inside each per-doc work still
    // accelerates a single doc's chunk-extraction inside one
    // processImage, but the outer `Promise.allSettled` ALWAYS
    // awaits so the parent sub-graph sees entity rows written
    // before alignment runs. No `waitForChunks` flag — chat path
    // never reaches here anymore (chat routing bypasses kbAgent's
    // ingestion chain entirely).
    const pendingChunks: Array<Promise<void>> = [];
    for (const pf of state.processedFiles) {
      if (pf.pipelineStatus === "new" && pf.docId) {
        const docId = pf.docId;
        const userId = state.userId;

        console.log(`[kbAgent] Starting chunkExtract task for docId=${docId}`);
        const work = (async () => {
          try {
            type ChunkInput = { id: string; ordinal: number; content: string };
            const isRetryFailedChunks = state.mode === "retryFailedChunks";

            const doc = await findKbDocumentById(userId, docId);
            if (!doc) {
              throw new Error(`Document ${docId} not found`);
            }
            const docTitle = doc.title ?? "Unknown Document";

            const extractModel = await getExtractModel();
            const entityQueue = new PQueue({ concurrency: KB_ENTITY_CONCURRENCY });

            let chunkInputs: ChunkInput[];
            let totalChunksForPrompt: number;

            if (isRetryFailedChunks) {
              const existing = await findKbChunksByDocumentId(userId, docId);
              const retryTargets = existing.filter((c) => c.status === "parsing");
              totalChunksForPrompt = existing.length;
              console.log(
                `[kbAgent] retryFailedChunks: docId=${docId}, ${retryTargets.length} to re-extract (out of ${totalChunksForPrompt})`,
              );
              chunkInputs = retryTargets.map((c) => ({
                id: c.id,
                ordinal: c.ordinal,
                content: c.content,
              }));
              if (chunkInputs.length === 0) {
                invalidateKbDoc(userId, docId);
                return;
              }
            } else {
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

              // ponytail: chunk rows are inserted with embedding=NULL —
              // chunk embedding is now chunk-embed-node's job (runs
              // after chunkAlignmentNode so vectors can include the
              // graph metadata for the chunk: entities + relationships
              // + themes, in lightRAG dual-level organization). This
              // node is now pure LLM extraction — owns the LLM cost
              // but defers bge-m3 batch embed for chunks.
              const lengthSplitter = new MarkdownTextSplitter({
                chunkSize: KB_CHUNK_SIZE,
                chunkOverlap: KB_CHUNK_OVERLAP,
              });

              const splitDocs = await lengthSplitter.createDocuments([fullMarkdown]);
              const rawTexts = splitDocs.map((d) => d.pageContent);
              const texts = mergeHrOnlyChunks(rawTexts);

              const chunkIds = texts.map(() => `c-${randomUUID()}`);
              extractedChunkIds.push(...chunkIds);

              totalChunksForPrompt = texts.length;
              chunkInputs = texts.map((text, i) => ({
                id: chunkIds[i]!,
                ordinal: i,
                content: text,
              }));

              await withKbTx(async (tx) => {
                await insertKbChunks(
                  tx,
                  texts.map((text, i) => ({
                    id: chunkIds[i]!,
                    documentId: docId,
                    ordinal: i,
                    content: text,
                    embedding: null,
                  })) as never,
                );
                await markAllKbChunksParsingForDocInTx(tx, docId);
              });
              console.log(
                `[kbAgent] Background task: successfully inserted ${texts.length} chunks for docId=${docId} (embedding deferred to chunkEmbedNode)`,
              );
            }

            if (SKIP_CHUNK_TO_ENTRIES) {
              return;
            }
            await Promise.allSettled(
              chunkInputs.map((chunk) =>
                entityQueue.add(async (): Promise<void> => {
                  const chunkId = chunk.id;
                  const ordinal = chunk.ordinal;
                  const text = chunk.content;

                  const systemMessage = new SystemMessage(KB_ENTITY_EXTRACTION_SYSTEM_PROMPT);
                  const humanMessage = new HumanMessage(
                    `Context Document Title: [${docTitle}]\n` +
                      `Chunk: [${ordinal + 1} / ${totalChunksForPrompt}]\n\n` +
                      `Text to extract:\n${text}`,
                  );

                  try {
                    const out = (await extractModel
                      .withStructuredOutput(graphRagSchema, { method: "jsonSchema", strict: true })
                      .invoke([systemMessage, humanMessage], {
                        ...config,
                        tags: ["nostream"],
                      })) as z.infer<typeof graphRagSchema>;

                    const norm = normalizeGraphRagOut(out);

                    // ponytail: per-chunk appLevelCanonical fallback
                    // (audit §15). When LLM alignment later runs via
                    // chunkAlignmentNode it folds cross-chunk
                    // variants, but inside ONE chunk we still need
                    // surface-form unification so the unique index
                    // (user_id, document_id, name) doesn't split one
                    // entity across many rows just because of casing
                    // drift inside the same LLM call.
                    const localNames = [
                      ...norm.entities.map((e) => e.name),
                      ...norm.relationships.flatMap((r) => [r.source, r.target]),
                    ];
                    for (const e of norm.entities) {
                      const canonName = appLevelCanonical(e.name, localNames);
                      await upsertKbEntity({
                        userId,
                        documentId: docId,
                        name: canonName,
                        type: e.type,
                        description: e.description,
                        chunkId,
                      });
                    }
                    for (const r of norm.relationships) {
                      const canonSource = appLevelCanonical(r.source, localNames);
                      const canonTarget = appLevelCanonical(r.target, localNames);
                      await upsertKbRelationship({
                        userId,
                        documentId: docId,
                        source: canonSource,
                        target: canonTarget,
                        relation: r.relation,
                        description: r.description,
                        chunkId,
                      });
                    }

                    // ponytail: per-chunk themes land flat on kb_theme
                    // (single source of truth — entities / relationships
                    // no longer carry themes). Idempotent on retry.
                    await replaceChunkThemes({
                      userId,
                      documentId: docId,
                      chunkId,
                      themes: norm.themes,
                    });

                    await markKbChunkSuccess(chunkId);
                  } catch (err) {
                    const msg = err instanceof Error ? (err as any).message : String(err);
                    console.error(
                      `kbAgent chunkExtractNode: chunk ${chunkId} failed (doc ${docId} ordinal ${ordinal}): ${msg}`,
                      err as any,
                    );
                    try {
                      await Promise.allSettled([
                        updateKbChunkForFailure(chunkId, msg),
                        markKbChunkFailed(chunkId, msg),
                      ]);
                    } catch (writeErr) {
                      console.error(
                        `kbAgent chunkExtractNode: failed-row write-back itself errored for chunk ${chunkId}:`,
                        writeErr,
                      );
                    }
                  }
                }),
              ),
            );

            invalidateKbDoc(userId, docId);
          } catch (err) {
            const pgErr = err as Error & {
              code?: string;
              detail?: string;
              hint?: string;
            };
            const reason = pgErr.code
              ? `${pgErr.code}: ${pgErr.detail ?? pgErr.message}${pgErr.hint ? ` (${pgErr.hint})` : ""}`
              : pgErr.message;
            console.error(
              `kbAgent chunkExtractNode: batch failure for doc ${docId}: ${reason}`,
              pgErr,
            );
          }
        })();
        pendingChunks.push(work);
      }
    }
    if (pendingChunks.length > 0) {
      await Promise.allSettled(pendingChunks);
    }
  }
  return { entityExtractedChunks: extractedChunkIds };
}
