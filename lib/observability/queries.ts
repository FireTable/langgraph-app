import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { observabilitySpans, type NewObservabilitySpanRow } from "./schema";
import type { CapturedSpan } from "@/backend/observability/callback-collector";

// ponytail: FORBIDDEN regex guards against secret leakage (api_key,
// baseURL, organization, Bearer). Spec FR-009 — runs on the
// JSON.stringify of the full row, so it catches every nested field.
// Match in any key or value; payload rejected on hit.
const FORBIDDEN =
  /(?:api[_-]?key|_password|^password$|_secret$|^secret$|baseURL|organization|bearer\s+[a-z0-9])/i;

function assertNoForbidden(span: CapturedSpan): void {
  if (FORBIDDEN.test(JSON.stringify(span))) {
    throw new Error(`observability: forbidden sensitive field in span ${span.span_id}`);
  }
}

function threadIdOf(span: CapturedSpan): string {
  const meta = span.meta as Record<string, unknown> | null | undefined;
  // LC v1.x dropped the langgraph_* prefix on some callback metadata
  // keys — the new key is `thread_id` (without prefix). Older paths
  // surfaced it as `langgraph_thread_id`. Accept both.
  const tid = meta?.thread_id ?? meta?.langgraph_thread_id;
  if (typeof tid === "string" && tid.length > 0) return tid;
  throw new Error(`observability: span ${span.span_id} missing meta.thread_id`);
}

function toRow(span: CapturedSpan): NewObservabilitySpanRow {
  return {
    spanId: span.span_id,
    threadId: threadIdOf(span),
    parentSpanId: span.parent_span_id,
    name: span.name,
    kind: span.kind,
    status: span.status,
    startedAt: span.started_at,
    endedAt: span.ended_at,
    input: span.input as never,
    output: span.output as never,
    usage: span.usage as never,
    error: span.error,
    meta: span.meta,
  };
}

function toCapturedSpan(row: typeof observabilitySpans.$inferSelect): CapturedSpan {
  return {
    span_id: row.spanId,
    parent_span_id: row.parentSpanId,
    name: row.name,
    kind: row.kind,
    status: row.status,
    started_at: row.startedAt,
    ended_at: row.endedAt,
    input: row.input,
    output: row.output,
    usage: row.usage as Record<string, unknown> | null,
    error: row.error,
    meta: row.meta as Record<string, unknown>,
  };
}

export async function bulkInsertSpans(spans: CapturedSpan[]): Promise<number> {
  if (spans.length === 0) return 0;
  for (const s of spans) assertNoForbidden(s);
  const rows = spans.map(toRow);
  // ponytail: ON CONFLICT DO NOTHING makes the write idempotent — the
  // same runId can fire bulkInsertSpans twice (parent chain end +
  // outermost chain end) and the second call is a no-op.
  const inserted = await db
    .insert(observabilitySpans)
    .values(rows)
    .onConflictDoNothing({ target: observabilitySpans.spanId })
    .returning({ spanId: observabilitySpans.spanId });
  return inserted.length;
}

export async function getSpansByThreadId(threadId: string): Promise<CapturedSpan[]> {
  const rows = await db
    .select()
    .from(observabilitySpans)
    .where(eq(observabilitySpans.threadId, threadId))
    .orderBy(observabilitySpans.startedAt);
  return rows.map(toCapturedSpan);
}

export async function markRunningAsFailed(threadId: string): Promise<number> {
  const result = await db
    .update(observabilitySpans)
    .set({ status: "failed" })
    .where(and(eq(observabilitySpans.threadId, threadId), eq(observabilitySpans.status, "running")))
    .returning({ spanId: observabilitySpans.spanId });
  return result.length;
}

export async function deleteSpansByThreadId(threadId: string): Promise<number> {
  const result = await db
    .delete(observabilitySpans)
    .where(eq(observabilitySpans.threadId, threadId))
    .returning({ spanId: observabilitySpans.spanId });
  return result.length;
}

// ponytail: retention physical delete — exported so the cron entry
// script can call it without re-implementing the SQL. Date.now()
// bound by the caller (scripts/cleanup-observability.ts).
export async function deleteSpansOlderThan(daysOld: number): Promise<number> {
  const cutoff = sql`now() - (${daysOld} || ' days')::interval`;
  const result = await db
    .delete(observabilitySpans)
    .where(lt(observabilitySpans.createdAt, cutoff))
    .returning({ spanId: observabilitySpans.spanId });
  return result.length;
}
