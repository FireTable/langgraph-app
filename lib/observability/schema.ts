import { bigint, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { threads } from "@/lib/threads/schema";

// CapturedSpan row — one per LangChain callback. Populated by
// CapturingHandler.handleChainEnd via bulkInsertSpans. Reads via
// getSpansByThreadId. Lifecycle:
//   handleChainStart  → in-memory map (no row)
//   handleChainEnd    → bulkInsert (one INSERT per runId, ON CONFLICT skip)
//   markRunningAsFailed (GET preflight) → UPDATE status='failed'
//   DELETE            → rows cleared by thread_id
//   thread DELETE     → ON DELETE CASCADE auto-removes rows
//
// ponytail: kind enum includes "node" because the handler's outer
// graph.invoke wrapper chain has `kind: "chain"` but the inner
// LangGraph nodes that wrap tool calls report `kind: "node"`. Two
// distinct values — collapsing them would mix sub-graph wrappers with
// leaf node wrappers in the waterfall.
export const observabilitySpans = pgTable(
  "observability_spans",
  {
    spanId: text("span_id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    parentSpanId: text("parent_span_id"),
    name: text("name").notNull(),
    kind: text("kind", {
      enum: ["llm", "tool", "node", "chain", "retriever", "unknown"],
    }).notNull(),
    status: text("status", { enum: ["running", "completed", "failed"] })
      .notNull()
      .default("running"),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    endedAt: bigint("ended_at", { mode: "number" }),
    input: jsonb("input"),
    output: jsonb("output"),
    usage: jsonb("usage"),
    error: text("error"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    // ponytail: column denormalized from meta.parent_message_id so the
    // path-param route (`/observability/<id>`) can hit a btree instead
    // of `meta ->> 'parent_message_id'`. Inserted via toRow's meta
    // projection; the meta key is preserved on read so downstream
    // consumers (panel renderers, transform layer) keep working.
    parentMessageId: text("parent_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // GET path: SELECT WHERE thread_id=? ORDER BY started_at
    index("observability_spans_thread_started_idx").on(t.threadId, t.startedAt),
    // GET filtered: SELECT WHERE thread_id=? AND parent_message_id=? ORDER BY started_at
    index("observability_spans_thread_parent_started_idx").on(
      t.threadId,
      t.parentMessageId,
      t.startedAt,
    ),
    // retention cron: DELETE WHERE created_at < now() - INTERVAL
    index("observability_spans_created_idx").on(t.createdAt),
  ],
);

export type ObservabilitySpanRow = typeof observabilitySpans.$inferSelect;
export type NewObservabilitySpanRow = typeof observabilitySpans.$inferInsert;
