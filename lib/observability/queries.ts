import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { observabilitySpans, type NewObservabilitySpanRow } from "./schema";
import type { CapturedSpan } from "@/lib/observability/callback";
import { langGraphClient } from "@/lib/langgraph/client";
import { lastHumanMessageId } from "@/lib/langgraph/last-human-message-id";

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
  // ponytail: parent_message_id backfill. The capture handler resolves
  // pmid per-call from `metadata.parent_message_id` (LangGraph
  // surfaces the `metadata` arg passed to `runs.create` on every LC
  // callback) with `lastHumanMessageId(inputs.messages)` as the
  // fallback — but `findLatestParentMessageId` is still useful for
  // spans where both paths miss (cold-start threads, interrupt
  // resumes whose capture preceded the metadata write). It calls
  // `langGraphClient.threads.getState(threadId)` and parses
  // `state.values.messages` via `lastHumanMessageId`; we never read
  // the `observability_spans` column for the fill.
  await backfillParentMessageIds(rows);
  // ponytail: finalize any prior `status: "waiting"` interrupt spans on
  // the same thread before this batch's INSERTs. The handler used to
  // track the open human span in-memory (`openHumanSpanId`), but that
  // field dies on `langgraphjs dev` process restart. DB-side fill is
  // race-free and survives restart: any tool span arriving for the
  // thread implicitly closes the wait gap that opened on the previous
  // tool's interrupt.

  await backfillWaitingInterruptSpans(rows);
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

// ponytail: resolve the latest HumanMessage id from the canonical
// LangGraph thread state. State is the source of truth for "which
// message is current on this thread right now" — better than reading
// the spans column, where any prior turn could have written a row with
// a later started_at that pollutes earlier spans (e.g. kb-upload inner
// spans stealing the pmid of the next user message). Returns null on
// fetch error so bulkInsertSpans can proceed with null pmids rather
// than crash the run.
export async function findLatestParentMessageId(threadId: string): Promise<string | null> {
  try {
    const state = await langGraphClient.threads.getState(threadId);
    const messages = (state as { values?: { messages?: unknown } } | null)?.values?.messages;
    return lastHumanMessageId(messages);
  } catch (err) {
    console.warn(
      `[observability] findLatestParentMessageId state fallback failed for thread ${threadId}:`,
      err,
    );
    return null;
  }
}

// ponytail: bound the state-fallback lookup so a stuck dev server
// (or a test env with no dev server) can't block the End hook past
// 500ms. The end-hook caller (handleChainEnd) awaits this whole
// INSERT before returning — a long hang here is directly visible as
// chat-turn latency. Returning null on timeout lets the row persist
// with `parent_message_id IS NULL`; the per-turn panel 404s for that
// span, which the design intentionally accepts (it surfaces "missing
// parent_message_id" instead of guessing).
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

// ponytail: for each row whose parent_message_id column is null, ask
// findLatestParentMessageId (which now reads thread state via
// langGraphClient) for the latest HumanMessage id on that thread and
// stamp it in. One state call per thread (deduplicated). Mutates rows
// in place.
async function backfillParentMessageIds(rows: NewObservabilitySpanRow[]): Promise<void> {
  const missingThreads = new Set<string>();
  for (const r of rows) {
    if (r.parentMessageId == null) {
      missingThreads.add(r.threadId);
    }
  }

  // ponytail: parallelize the per-thread state lookups + 500ms cap each
  // so a worst-case batch with N distinct missing threads adds at most
  // ~500ms to the End hook (not N × RTT). Stale fetches resolve as null
  // and the rows stay pmid-less; the per-turn panel 404s those rows
  // by design.
  const latestByThread = new Map<string, string | null>();
  await Promise.all(
    [...missingThreads].map(async (tid) => {
      latestByThread.set(tid, await withTimeout(findLatestParentMessageId(tid), 500));
    }),
  );

  for (const r of rows) {
    const latest = latestByThread.get(r.threadId);
    if (r.parentMessageId == null && latest) {
      r.parentMessageId = latest;
    }
  }
}

// ponytail: close any prior waiting human (interrupt) span on threads
// represented in this batch. We match by `meta->>'interrupt_tool'`
// so only the gap belonging to the resumed tool is closed — a fresh
// interrupt on a different tool still waits. The handler's openHumanSpanId
// in-memory finalize was dropped (dies on langgraphjs dev restart);
// the DB-side backfill is the survivor. The resume trigger is a tool
// span in the incoming batch whose `name` matches a waiting human
// span's `interrupt_tool`; ended_at is set to the resume tool's
// started_at so the waterfall shows the gap as closed.
//
// ponytail: waiting CHAIN wrappers are NOT backfilled here. Their
// `ended_at` was stamped by handleChainError at interrupt time, and
// transform.ts renders the step as "completed" via bucket.ended
// (the raw span status field doesn't drive the panel's step display).
// Flipping the chain wrapper to "completed" on tool arrival would
// overstate the chain's progress — it could still be processing the
// resume payload. Leave it at status="waiting"; the wrapper's own
// record lives in the panel as a closed bar (ended_at is set) at
// the interrupt moment, and any post-resume work shows as new bars.
async function backfillWaitingInterruptSpans(rows: NewObservabilitySpanRow[]): Promise<void> {
  const resumePairs = new Map<string, { toolName: string; resumeAt: number }>();
  for (const r of rows) {
    if (r.kind !== "tool" && r.kind !== "node") continue;
    if (!resumePairs.has(r.threadId)) {
      resumePairs.set(r.threadId, {
        toolName: r.name,
        resumeAt: r.startedAt > 0 ? r.startedAt : Date.now(),
      });
    }
  }
  for (const [tid, pair] of resumePairs) {
    await db
      .update(observabilitySpans)
      .set({ status: "completed", endedAt: pair.resumeAt })
      .where(
        and(
          eq(observabilitySpans.threadId, tid),
          eq(observabilitySpans.kind, "human"),
          eq(observabilitySpans.status, "waiting"),
          eq(sql`${observabilitySpans.meta}->>'interrupt_tool'`, pair.toolName),
        ),
      );
  }

  // ponytail: chain wrappers stuck at status="waiting" / ended_at=null
  // (set by handleChainError when GraphInterrupt bubbled up) are
  // backfilled the moment a chain wrapper carrying
  // `output.output = "__end__"` lands for the same thread. The
  // `__end__` marker is the LangGraph signal that the branch exited,
  // so the parent wrapper is finally done — handleChainEnd never fires
  // for the prior turn's wrappers because their handleChainError
  // already finalized them. The lookup walks up the ns tree by one
  // `|tail` to find the parent wrapper: the outer subgraph shares its
  // ns suffix across interrupt + resume turns, but inner steps don't
  // (different uuid per turn), so exact-ns match would miss.
  for (const r of rows) {
    if (r.kind !== "chain") continue;
    const output = r.output as { output?: unknown } | null;
    if (!output || output.output !== "__end__") continue;
    const meta = r.meta as Record<string, unknown> | null | undefined;
    const ns = meta?.langgraph_checkpoint_ns;
    if (typeof ns !== "string") continue;
    const lastPipe = ns.lastIndexOf("|");
    if (lastPipe <= 0) continue;
    const parentNs = ns.slice(0, lastPipe);
    const endAt = r.endedAt ?? r.startedAt;
    if (endAt <= 0) continue;
    await db
      .update(observabilitySpans)
      .set({ status: "completed", endedAt: endAt })
      .where(
        and(
          eq(observabilitySpans.threadId, r.threadId),
          eq(observabilitySpans.kind, "chain"),
          eq(observabilitySpans.status, "waiting"),
          eq(sql`${observabilitySpans.meta}->>'langgraph_checkpoint_ns'`, parentNs),
        ),
      );
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
