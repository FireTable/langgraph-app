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

export const GetSpansResponseSchema = z.object({
  thread_id: z.string().min(1),
  retention_days: z.number().int().positive(),
  spans: z.array(CapturedSpanSchema),
});

export const DeleteSpansResponseSchema = z.object({
  cleared: z.number().int().nonnegative(),
});

export const IdParamsSchema = z.object({ id: z.string().min(1) });

export type CapturedSpanDTO = z.infer<typeof CapturedSpanSchema>;
export type GetSpansResponse = z.infer<typeof GetSpansResponseSchema>;
export type DeleteSpansResponse = z.infer<typeof DeleteSpansResponseSchema>;
