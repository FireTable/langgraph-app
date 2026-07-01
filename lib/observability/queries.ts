import { and, desc, eq, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { observabilitySpans, type NewObservabilitySpanRow } from "./schema";
import type { CapturedSpan } from "@/backend/observability/callback-collector";

// ponytail: FORBIDDEN regex flags fields that often hold secrets
// (api_key, baseURL, organization, Bearer tokens). Spec FR-009 bans
// these from the DB verbatim, but the same patterns match innocent
// user prose like "what's my api key" — we can't tell them apart at
// the regex level, so we redact-instead-of-ban: keep the first 5 chars
// of the value (so the panel can see the key WAS used) and mask the
// rest. Same regex, no throw, no false-positive drop.
const FORBIDDEN = /(?:api[_-]?key|_password|^password$|_secret$|^secret$|bearer\s+[a-z0-9])/i;

const FORBIDDEN_VALUE_RE =
  /("(?:api[_-]?key|openai_api_key|authorization|_password|^password$|_secret$|^secret$)":\s*)"([^"]*)"/gi;
// ponytail: catch-all for Bearer tokens sitting in any field name
// (header / cookie / custom-thing), not just authorization. Matches
// `"Bearer ` then token chars up to the next closing quote, replaces
// the token portion with first-5 + "***".
const FORBIDDEN_BEARER_RE = /("Bearer\s+)([A-Za-z0-9_/+=-]+)(?=")/gi;

function redactForbidden(span: CapturedSpan): CapturedSpan {
  const str = JSON.stringify(span);
  if (!FORBIDDEN.test(str)) return span;
  // ponytail: Bearer tokens get the "Bearer" prefix preserved and only
  // the token portion is masked — the panel still sees "Bearer <prefix>***"
  // so the auth scheme is recognizable. All other matched values get
  // the leading 5 chars + "***" treatment.
  const redacted = str
    .replace(FORBIDDEN_VALUE_RE, (_m, prefix: string, value: string) => {
      const bearer = value.match(/^(Bearer\s+)([A-Za-z0-9_/+=-]+)/i);
      if (bearer) {
        return `${prefix}"${bearer[1]}${bearer[2].slice(0, 5)}***"`;
      }
      return `${prefix}"${value.slice(0, 5)}***"`;
    })
    .replace(
      FORBIDDEN_BEARER_RE,
      (_m, prefix: string, value: string) => `${prefix}${value.slice(0, 5)}***`,
    );
  console.warn(`[observability] redacted forbidden field in span ${span.span_id}`);
  return JSON.parse(redacted) as CapturedSpan;
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
  // ponytail: meta stays the canonical source — the callback handler
  // writes the value to meta.parent_message_id (keeping it close to
  // other runtime-only fields like langgraph_node/step). The column is
  // populated here as an indexable projection; on read we put it back
  // into meta so consumers see a single "parent_message_id" source.
  const meta = span.meta as Record<string, unknown> | null | undefined;
  const rawPmid = meta?.parent_message_id;
  const parentMessageId = typeof rawPmid === "string" && rawPmid.length > 0 ? rawPmid : null;
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
    parentMessageId,
  };
}

function toCapturedSpan(row: typeof observabilitySpans.$inferSelect): CapturedSpan {
  // ponytail: re-hydrate meta.parent_message_id from the column so the
  // panel renderers + transform layer keep working with the original
  // meta shape (they pre-date the column promotion).
  const meta = (row.meta as Record<string, unknown> | null | undefined) ?? {};
  const metaWithPmid = meta.parent_message_id
    ? meta
    : row.parentMessageId
      ? { ...meta, parent_message_id: row.parentMessageId }
      : meta;
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
    meta: metaWithPmid,
  };
}

export async function bulkInsertSpans(spans: CapturedSpan[]): Promise<number> {
  if (spans.length === 0) return 0;
  const rows = spans.map((s) => toRow(redactForbidden(s)));
  // ponytail: parent_message_id backfill. Before INSERT, look up the
  // column (not the meta key — the column is the canonical source) for
  // any thread whose rows still have parent_message_id null. This is
  // what the capture handler can't reach (race between outermost
  // start()'s async DB lookup and bulkInsertSpans firing on End).
  // Reads use the column so a row written by an earlier invoke but
  // persisted without parent_message_id still drives the fill here.
  await backfillParentMessageIds(rows);
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

// ponytail: latest non-null parent_message_id for the thread. Reads
// the column directly — meta->>'parent_message_id' jsonb path was
// dropped because the column is now the canonical store. Used both
// from CapturingHandler.start() (outermost-resume path) and from
// bulkInsertSpans' backfill (pre-INSERT gap-fill).
export async function findLatestParentMessageId(threadId: string): Promise<string | null> {
  const [row] = await db
    .select({ pmid: observabilitySpans.parentMessageId })
    .from(observabilitySpans)
    .where(
      and(eq(observabilitySpans.threadId, threadId), isNotNull(observabilitySpans.parentMessageId)),
    )
    .orderBy(desc(observabilitySpans.startedAt))
    .limit(1);
  const value = row?.pmid;
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ponytail: for each row whose parent_message_id column is null, look
// up the most recent non-null value on that thread and fill it in.
// One DB call per thread (deduplicated). Mutates the rows in place.
async function backfillParentMessageIds(rows: NewObservabilitySpanRow[]): Promise<void> {
  const missingThreads = new Set<string>();
  for (const r of rows) {
    if (r.parentMessageId == null) missingThreads.add(r.threadId);
  }
  for (const tid of missingThreads) {
    const latest = await findLatestParentMessageId(tid);
    if (!latest) continue;
    for (const r of rows) {
      if (r.threadId === tid && r.parentMessageId == null) {
        r.parentMessageId = latest;
      }
    }
  }
}

export async function getSpansByThreadId(
  threadId: string,
  opts: { parentMessageId?: string } = {},
): Promise<CapturedSpan[]> {
  // ponytail: the column is now a first-class indexable field (see
  // observability_spans_thread_parent_started_idx). Filter on the column
  // directly so the planner can use the btree; the meta jsonb path
  // survives as the ingest-time source of truth (toRow projects it into
  // the column on insert). Omit / undefined → no filter, return all
  // spans for the thread (used by the `/observability` route).
  const conds = [eq(observabilitySpans.threadId, threadId)];
  if (opts.parentMessageId) {
    conds.push(eq(observabilitySpans.parentMessageId, opts.parentMessageId));
  }
  const rows = await db
    .select()
    .from(observabilitySpans)
    .where(and(...conds))
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
