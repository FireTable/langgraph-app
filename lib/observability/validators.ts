import { z } from "zod";

// Single source of truth for the wire shape of CapturedSpan ↔ DB row ↔
// API response. The callback handler builds the in-memory CapturedSpan,
// queries.ts writes to DB, the GET handler re-hydrates to this exact
// shape. The DB column types allow JSON null in the jsonb columns, so
// each side nullable.

export const CapturedSpanSchema = z.object({
  span_id: z.string(),
  parent_span_id: z.string().nullable(),
  name: z.string(),
  kind: z.enum(["llm", "tool", "node", "chain", "retriever", "unknown"]),
  status: z.enum(["running", "completed", "failed"]),
  started_at: z.number().int().nonnegative(),
  ended_at: z.number().int().nonnegative().nullable(),
  input: z.unknown().nullable(),
  output: z.unknown().nullable(),
  usage: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  meta: z.record(z.string(), z.unknown()),
});

// ponytail: SpanData is the @assistant-ui/react-o11y waterfall input
// shape (strict — no extras). We re-validate on the wire so the panel
// can trust what comes back without re-deriving from CapturedSpan.
// `parentMessageId` is our extension: the turn this row belongs to.
// The panel uses it to build the per-turn detail URL. Optional —
// pre-`parent_message_id` backfill rows or partial captures won't have
// it, and those rows' detail fetches 404 (the SDK fallback also won't
// find them in another turn).
export const SpanDataSchema = z.object({
  id: z.string(),
  parentSpanId: z.string().nullable(),
  name: z.string(),
  type: z.string(),
  status: z.enum(["running", "completed", "failed", "skipped"]),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  parentMessageId: z.string().min(1).optional(),
});

// ponytail: the API ships a pre-computed root aggregate so the panel
// doesn't need raw spans to render the stat-card row. Mirrors
// RootAggregate in lib/observability/aggregate.ts.
export const AggregateSchema = z.object({
  totalDurationMs: z.number().int().nonnegative(),
  totalInput: z.number().int().nonnegative(),
  totalOutput: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  totalCacheRead: z.number().int().nonnegative(),
  totalReasoning: z.number().int().nonnegative(),
  ttftAvgMs: z.number().nullable(),
  ttftMaxMs: z.number().nullable(),
  llmSpanCount: z.number().int().nonnegative(),
  toolSpanCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  humanCount: z.number().int().nonnegative(),
});

// ponytail: a single in-flight run as returned by langGraphClient.runs.list.
// Subset of the SDK's full Run — only the fields the panel actually renders.
// `metadata.parent_message_id` is the contract that lets the API filter
// runs to the current chat turn (triggerBackgroundAgentNode stamps it on
// every bg runs.create; main agent runs are not stamped by us — see
// docs/APIS.md § Observability in_flight_runs for the gap).
export const InFlightRunSchema = z.object({
  run_id: z.string(),
  thread_id: z.string(),
  assistant_id: z.string(),
  status: z.enum(["pending", "running"]),
  created_at: z.string(),
  updated_at: z.string(),
  metadata: z.looseObject({
    parent_message_id: z.string().nullable().optional(),
  }),
});

export const GetSpansResponseSchema = z.object({
  thread_id: z.string().min(1),
  retention_days: z.number().int().positive(),
  parent_message_id: z.string().min(1).nullable(),
  // ponytail: SpanData[] (not CapturedSpan[]) — the route transforms
  // server-side via lib/observability/transform.ts so the panel never
  // receives raw callback payloads.
  spans: z.array(SpanDataSchema),
  // ponytail: pre-computed stat-card aggregate, computed server-side
  // from the raw spans. Null when the thread has no spans yet.
  aggregate: AggregateSchema.nullable(),
  // ponytail: always present (empty array when no in-flight runs). Lets
  // the panel render a "background agent processing…" placeholder
  // without a separate code path for "field missing" vs "field empty".
  in_flight_runs: z.array(InFlightRunSchema),
  // ponytail: synthetic step-wrapper id → representative raw span_id.
  // The waterfall's step rows have synthetic ids (e.g. "step-3-routerAgent-...")
  // but the detail endpoint resolves via raw span_id, so the panel looks
  // the mapping up here. Empty when the thread has no step wrappers.
  step_id_to_raw_span_id: z.record(z.string(), z.string()),
});

export const DeleteSpansResponseSchema = z.object({
  cleared: z.number().int().nonnegative(),
});

export const GetSpanDetailResponseSchema = z.object({
  thread_id: z.string().min(1),
  span: CapturedSpanSchema,
});

export const IdParamsSchema = z.object({ id: z.string().min(1) });
export const ParentMessageIdParamsSchema = z.object({
  id: z.string().min(1),
  parentMessageId: z.string().min(1),
});
export const SpanDetailParamsSchema = z.object({
  id: z.string().min(1),
  parentMessageId: z.string().min(1),
  spanId: z.string().min(1),
});

export type CapturedSpanDTO = z.infer<typeof CapturedSpanSchema>;
export type SpanDataDTO = z.infer<typeof SpanDataSchema>;
export type AggregateDTO = z.infer<typeof AggregateSchema>;
export type InFlightRun = z.infer<typeof InFlightRunSchema>;
export type GetSpansResponse = z.infer<typeof GetSpansResponseSchema>;
export type DeleteSpansResponse = z.infer<typeof DeleteSpansResponseSchema>;
export type GetSpanDetailResponse = z.infer<typeof GetSpanDetailResponseSchema>;
