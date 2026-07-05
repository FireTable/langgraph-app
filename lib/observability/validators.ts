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
  spans: z.array(CapturedSpanSchema),
  // ponytail: always present (empty array when no in-flight runs). Lets
  // the panel render a "background agent processing…" placeholder
  // without a separate code path for "field missing" vs "field empty".
  in_flight_runs: z.array(InFlightRunSchema),
});

export const DeleteSpansResponseSchema = z.object({
  cleared: z.number().int().nonnegative(),
});

export const IdParamsSchema = z.object({ id: z.string().min(1) });

export type CapturedSpanDTO = z.infer<typeof CapturedSpanSchema>;
export type InFlightRun = z.infer<typeof InFlightRunSchema>;
export type GetSpansResponse = z.infer<typeof GetSpansResponseSchema>;
export type DeleteSpansResponse = z.infer<typeof DeleteSpansResponseSchema>;
