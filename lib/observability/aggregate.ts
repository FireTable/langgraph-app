import type { CapturedSpan } from "@/backend/observability/callback-collector";

// ponytail: shared aggregate computation. Used by the API route
// (server-side pre-compute) AND by the panel for tests / type imports.
// Living at lib/observability/ rather than backend/observability/ so
// the panel (a "use client" file) can import the types without dragging
// the backend/observability/callback-collector runtime into the browser
// bundle. Pure data → safe.

export type TokenBreakdown = {
  input: number;
  output: number;
  total: number;
  cache_read: number;
  reasoning: number;
};

export function readTokens(
  usage: Record<string, unknown> | null | undefined,
): TokenBreakdown | null {
  if (!usage) return null;
  const u = usage as Record<string, unknown>;
  const input = (u.input_tokens as number | undefined) ?? 0;
  const output = (u.output_tokens as number | undefined) ?? 0;
  const total = (u.total_tokens as number | undefined) ?? input + output;
  const inputDetails = (u.input_token_details as Record<string, unknown> | undefined) ?? {};
  const outputDetails = (u.output_token_details as Record<string, unknown> | undefined) ?? {};
  return {
    input,
    output,
    total,
    cache_read: (inputDetails.cache_read as number | undefined) ?? 0,
    reasoning: (outputDetails.reasoning as number | undefined) ?? 0,
  };
}

// ponytail: aggregate every LLM span's tokens in a thread for the root
// stat card. LangSmith shows "13.77s · 4.9K" — we mirror that shape.
export type RootAggregate = {
  totalDurationMs: number;
  totalInput: number;
  totalOutput: number;
  // ponytail: input + output billed tokens, excluding cache_read (which
  // the provider already credits; counting it again inflates the total).
  totalTokens: number;
  totalCacheRead: number;
  totalReasoning: number;
  // ponytail: TTFT (time-to-first-token) is stamped on LLM spans by
  // CapturingHandler.handleLLMNewToken as meta.time_to_first_token_ms
  // (ms from span start). Mean / max surface streaming latency.
  ttftAvgMs: number | null;
  ttftMaxMs: number | null;
  llmSpanCount: number;
  toolSpanCount: number;
  failedCount: number;
  humanCount: number;
};

export function aggregateRoot(spans: CapturedSpan[]): RootAggregate | null {
  if (spans.length === 0) return null;
  const llms = spans.filter((s) => s.kind === "llm" && s.usage);
  let input = 0,
    output = 0,
    cache_read = 0,
    reasoning = 0;
  for (const s of llms) {
    const t = readTokens(s.usage);
    if (!t) continue;
    input += t.input;
    output += t.output;
    cache_read += t.cache_read;
    reasoning += t.reasoning;
  }
  let minStart = Infinity,
    maxEnd = 0;
  for (const s of spans) {
    if (s.started_at < minStart) minStart = s.started_at;
    if (s.ended_at && s.ended_at > maxEnd) maxEnd = s.ended_at;
  }
  const ttftValues: number[] = [];
  for (const s of llms) {
    const v = (s.meta as Record<string, unknown> | null | undefined)?.time_to_first_token_ms;
    if (typeof v === "number" && v > 0) ttftValues.push(v);
  }
  const ttftAvgMs =
    ttftValues.length > 0 ? ttftValues.reduce((a, b) => a + b, 0) / ttftValues.length : null;
  const ttftMaxMs = ttftValues.length > 0 ? ttftValues.reduce((a, b) => Math.max(a, b), 0) : null;

  return {
    totalDurationMs: maxEnd > minStart ? maxEnd - minStart : 0,
    totalInput: input,
    totalOutput: output,
    totalTokens: input + output,
    totalCacheRead: cache_read,
    totalReasoning: reasoning,
    ttftAvgMs,
    ttftMaxMs,
    llmSpanCount: llms.length,
    toolSpanCount: spans.filter((s) => s.kind === "tool").length,
    failedCount: spans.filter((s) => s.status === "failed").length,
    humanCount: spans.filter((s) => s.kind === "human").length,
  };
}
