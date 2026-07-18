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

// ponytail: Drizzle's built-in types don't cover pgvector's `vector(1536)`
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
const tsvectorEnglish = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED";
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
// pgvector; `tsv` is a generated tsvector column (English) used by the
// BM25 leg. v3 retrieval tools will hit both columns; v2 just stores.
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
    tsv: tsvectorEnglish("tsv").notNull(),
    entities: jsonb("entities")
      .$type<Array<{ name: string; type: string; description: string }>>()
      .notNull()
      .default([]),
    relationships: jsonb("relationships")
      .$type<Array<{ source: string; target: string; relation: string; description: string }>>()
      .notNull()
      .default([]),
    themes: text("themes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // ponytail: per-chunk status — independent of kb_document.status so
    // a failed entity extract can mark a single chunk failed without
    // downgrading the whole document. Default 'pending' so freshly
    // inserted chunks are visible to the UI before the embedding
    // pass completes. The legacy migration sets DEFAULT 'success'
    // (NOT 'pending') so existing rows stay searchable — see
    // 0008_*.sql for the rationale.
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
    // GIN over extracted entities — graphRAG seed queries.
    index("kb_chunk_entities_idx").using("gin", t.entities),
    index("kb_chunk_themes_idx").using("gin", t.themes),
  ],
);

export type KbFolder = typeof kbFolder.$inferSelect;
export type NewKbFolder = typeof kbFolder.$inferInsert;
export type KbDocument = typeof kbDocument.$inferSelect;
export type NewKbDocument = typeof kbDocument.$inferInsert;
export type KbChunk = typeof kbChunk.$inferSelect;
export type NewKbChunk = typeof kbChunk.$inferInsert;

// keep imports referenced (linter)
void bigint;
