import { sql } from "drizzle-orm";
import {
  bigint,
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  jsonb,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "@/lib/auth/schema";
import { attachments } from "@/lib/attachments/schema";

// ponytail: v2 KB schema (issue #13). Mirrors the layout used by
// `lib/attachments/schema.ts` / `lib/memory/schema.ts`. The four-state
// lifecycle is its own pgEnum so a typo'd status string fails at insert
// instead of silently leaking into `findKbDocumentByContentHash` lookups
// (status 'succes' would never match a 'success' row).
export const kbDocStatusEnum = pgEnum("kb_doc_status", ["pending", "parsing", "success", "failed"]);

// ponytail: same shape as kbDocStatusEnum — chunks inherit the
// doc-pipeline status taxonomy so callers can compare / branch on
// it without a translation layer. `pending` is the default for
// fresh chunks emitted by chunkEmbedStoreNode before the
// embedding + entity-extract pass lands; `failed` is the
// per-chunk terminal state when entity extraction blows up
// without affecting the parent kb_document row (its status
// stays at `success` even if a few chunks failed — user
// sees Ready in the table, the failed chunks just don't
// contribute to RAG retrieval; the doc detail dialog surfaces
// them via `chunks_failed_count`).
export const kbChunkStatusEnum = pgEnum("kb_chunk_status", [
  "pending",
  "parsing",
  "success",
  "failed",
]);

// ponytail: Drizzle's built-in types don't cover pgvector's `vector(EMBEDDING_DIM)`
// yet. customType pins the SQL string + the JS shape (number[]) so the
// ponytail: pgvector dimension 1024. The embedder is BAAI/bge-m3
// (served by apimart under the OPENAI_EMBEDDING_MODEL alias); bge-m3
// returns 1024 dims by default. schema column + HNSW index must agree
// on dim — pgvector refuses vector inserts of the wrong size with
// 22P02, and HNSW can't be built against a column whose dim doesn't
// match the index operator's dim. If you switch embedders, bump the
// dim here AND run the matching ALTER COLUMN migration.
export const EMBEDDING_DIM = 1024;
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return `vector(${EMBEDDING_DIM})`;
  },
  toDriver(value: number[]): string {
    // pgvector accepts the array literal directly when cast.
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .slice(1, -1)
      .split(",")
      .map((n) => Number.parseFloat(n));
  },
});

// ponytail: tsvector GENERATED ALWAYS AS ... STORED. Drizzle 0.45 doesn't
// have a first-class generator; pin via customType + $default(() => ...)
// so the SELECT path reads the computed column without us trying to
// write to it. Writes go through INSERT with only `content`; the rest
// is the DB's job.
const tsvectorSimple = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED";
  },
});

// One folder per user (default "Attachments" auto-created on first KB
// upload). group docs; future v3 lets users create folders by hand.
export const kbFolder = pgTable(
  "kb_folder",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // "find default folder by name" is the hot path for the ingest.
    uniqueIndex("kb_folder_user_name_idx").on(t.userId, t.name),
    index("kb_folder_user_idx").on(t.userId),
  ],
);

// One row per ingested PDF (issue #13 v2). Lifecycle:
//   pending → parsing → success
//              ↘ failed
// `attachment_id` is the source FK (chat upload → KB). NO `source_url`
// column in v2 (URL ingestion deferred to v3).
export const kbDocument = pgTable(
  "kb_document",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    folderId: text("folder_id")
      .notNull()
      // RESTRICT — folder shouldn't disappear from under its docs.
      // Caller moves docs to another folder before deleting a folder.
      .references(() => kbFolder.id, { onDelete: "restrict" }),
    attachmentId: text("attachment_id").references(() => attachments.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    contentType: text("content_type").notNull(),
    // sha256 hex, or `r2key:<r2Key>` fallback when attachment.sha256 is null
    // (legacy browsers). Unique per user → PRIMARY dedup key in v2.
    contentHash: text("content_hash").notNull(),
    status: kbDocStatusEnum("status").notNull().default("pending"),
    errorMessage: text("error_message"),
    pages: jsonb("pages").$type<unknown[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // PRIMARY dedup path: kbAgent.screenshotNode probes this on every upload.
    uniqueIndex("kb_document_user_contenthash_idx").on(t.userId, t.contentHash),
    // Secondary dedup + Settings tab list (paginated, newest first).
    index("kb_document_user_created_idx").on(t.userId, t.createdAt.desc()),
    index("kb_document_folder_idx").on(t.folderId),
    // Backup dedup: same attachment uploaded twice (sha256 colission).
    index("kb_document_user_attachment_idx").on(t.userId, t.attachmentId),
  ],
);

// Chunks produced by kbAgent.chunkEmbedStoreNode. Embeddings stored as
// pgvector; `tsv` is a generated tsvector column (simple) used by the
// BM25 leg.
export const kbChunk = pgTable(
  "kb_chunk",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => kbDocument.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding").notNull(),
    tsv: tsvectorSimple("tsv").notNull(),
    // ponytail: per-chunk status — independent of kb_document.status so
    // a failed entity extract can mark a single chunk failed without
    // downgrading the whole document. Default 'pending' so freshly
    // inserted chunks are visible to the UI before the embedding
    // pass completes.
    status: kbChunkStatusEnum("status").notNull().default("pending"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Per-document ordering + retrieval filter.
    index("kb_chunk_document_ordinal_idx").on(t.documentId, t.ordinal),
    // HNSW pgvector index — vector_cosine_ops matches OpenAI embeddings.
    index("kb_chunk_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    // GIN over the generated tsvector for BM25-style full-text lookup.
    index("kb_chunk_tsv_idx").using("gin", t.tsv),
  ],
);

// ponytail: Step 3 (audit §8) GraphRAG entity table. Stores extracted
// canonical entities with embeddings for GraphRAG ANN entrypoints.
export const kbEntity = pgTable(
  "kb_entity",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    documentId: text("document_id")
      .notNull()
      .references(() => kbDocument.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").notNull(),
    description: text("description").notNull(),
    sourceChunkIds: text("source_chunk_ids")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    embedding: vector("embedding"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("kb_entity_user_doc_name_idx").on(t.userId, t.documentId, t.name),
    index("kb_entity_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("kb_entity_user_name_idx").on(t.userId, t.name),
    index("kb_entity_document_idx").on(t.documentId),
  ],
);

// ponytail: Step 3 (audit §8) GraphRAG relationship table. Stores directed
// relationships connecting entities with embeddings for GraphRAG ANN entrypoints.
export const kbRelationship = pgTable(
  "kb_relationship",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    documentId: text("document_id")
      .notNull()
      .references(() => kbDocument.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    target: text("target").notNull(),
    relation: text("relation").notNull(),
    description: text("description").notNull(),
    sourceChunkIds: text("source_chunk_ids")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    weight: integer("weight").notNull().default(1),
    embedding: vector("embedding"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("kb_relationship_user_doc_str_idx").on(
      t.userId,
      t.documentId,
      t.source,
      t.target,
      t.relation,
    ),
    index("kb_relationship_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("kb_relationship_user_source_idx").on(t.userId, t.documentId, t.source),
    index("kb_relationship_user_target_idx").on(t.userId, t.documentId, t.target),
    index("kb_relationship_document_idx").on(t.documentId),
  ],
);

// ponytail: per-chunk themes table (single source of truth, replaces
// the previous fan-out into kb_entity.themes / kb_relationship.themes).
// One row per (chunk, theme name); the LLM emits one themes list per
// chunk and we persist it as flat rows. Front-end doc-detail JOINs
// `kb_theme WHERE chunk_id IN (...)` to surface the chip; the entity
// embed path also JOINs this table to prepend themes into the entity's
// ANN text (audit §13b line 456). Unique on (chunk_id, name) so a
// retry can ON CONFLICT DO NOTHING instead of producing duplicates.
//
// Theme alignment is in-place via entity-alignment-node.ts: the LLM
// emits `themeAliases: [{ canonicalName, aliases: [...] }]` and the
// matching rows in kb_theme have their `name` UPDATE'd to the
// canonical form (no `canonical_name` column). Original variants
// collapse to the canonical on the next doc-detail read.
export const kbTheme = pgTable(
  "kb_theme",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    documentId: text("document_id")
      .notNull()
      .references(() => kbDocument.id, { onDelete: "cascade" }),
    chunkId: text("chunk_id")
      .notNull()
      .references(() => kbChunk.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("kb_theme_chunk_name_idx").on(t.chunkId, t.name),
    index("kb_theme_user_name_idx").on(t.userId, t.name),
    index("kb_theme_user_document_idx").on(t.userId, t.documentId),
    index("kb_theme_chunk_idx").on(t.chunkId),
  ],
);

export type KbFolder = typeof kbFolder.$inferSelect;
export type NewKbFolder = typeof kbFolder.$inferInsert;
export type KbDocument = typeof kbDocument.$inferSelect;
export type NewKbDocument = typeof kbDocument.$inferInsert;
export type KbChunk = typeof kbChunk.$inferSelect;
export type NewKbChunk = typeof kbChunk.$inferInsert;
export type KbEntity = typeof kbEntity.$inferSelect;
export type NewKbEntity = typeof kbEntity.$inferInsert;
export type KbRelationship = typeof kbRelationship.$inferSelect;
export type NewKbRelationship = typeof kbRelationship.$inferInsert;
export type KbTheme = typeof kbTheme.$inferSelect;
export type NewKbTheme = typeof kbTheme.$inferInsert;

// ponytail: per-kbAgent-invocation observability event. Every kbAgent run
// (standalone via fireIngestionRun OR chat subgraph via mainAgent) inserts
// a row here from prepareKBDataNode, giving the Settings → KB
// observability popover a per-doc run history without depending on
// LangGraph SDK runs.list
// (which only sees runs on a single thread — chat uploads land on the chat
// thread, not on the docId-derived thread the popover used to query).
//
// `source` captures the trigger path; `mode` is the dispatch mode. `run_id`
// is nullable because chat-path subgraph invocations don't always expose
// config.configurable.run_id reliably. `parent_message_id` is the synthetic
// HumanMessage id (standalone) or the user's chat message id (chat path) —
// same value CapturingHandler stamps onto every span via meta.parent_message_id,
// so a JOIN against observability_spans is one indexed lookup.
export const kbObservabilitySourceEnum = pgEnum("kb_observability_source", [
  "kb-upload",
  "kb-reprocess",
  "chat",
]);

export const kbObservabilityModeEnum = pgEnum("kb_observability_mode", [
  "full",
  "chunksOnly",
  "retryFailed",
  "retryFailedChunks",
]);

export const kbObservability = pgTable(
  "kb_observability",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    docId: text("doc_id")
      .notNull()
      .references(() => kbDocument.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    parentMessageId: text("parent_message_id").notNull(),
    runId: text("run_id"),
    source: kbObservabilitySourceEnum("source").notNull(),
    mode: kbObservabilityModeEnum("mode").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // popover query path: list runs for one docId, newest first.
    index("kb_observability_doc_created_idx").on(t.docId, t.createdAt.desc()),
  ],
);

export type KbObservability = typeof kbObservability.$inferSelect;
export type NewKbObservability = typeof kbObservability.$inferInsert;

// keep imports referenced (linter)
void bigint;
