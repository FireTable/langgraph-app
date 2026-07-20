import type { CapturedSpan } from "@/lib/observability/callback";
import type { WireSpanData } from "@/lib/observability/transform";

// ponytail: shared aggregate computation. Used by the API route
// (server-side pre-compute) AND by the panel for tests / type imports.
// Living at lib/observability/ rather than backend/observability/ so
// the panel (a "use client" file) can import the types without dragging
// the backend/observability/callback-collector runtime into the browser
// bundle. Pure data → safe.
//
// ponytail: aggregateRoot takes BOTH arrays for an honest split of
// concerns. CapturedSpan carries the side-channel fields the panel
// doesn't render — `usage` tokens, `meta.time_to_first_token_ms` — so
// total tokens + ttft come from there. WireSpanData is the waterfall
// shape: every span the panel shows IS in this array, and the
// parentSpanId links are built-in. Counting failed causes off the wire
// keeps the failedCount aligned with what's actually visible (one LLM
// throw = one failed leaf, not "main → kbAgent → ocr node → llm" = 4).

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

export function aggregateRoot(
  captured: CapturedSpan[],
  wire: WireSpanData[],
): RootAggregate | null {
  if (wire.length === 0 && captured.length === 0) return null;
  const llms = captured.filter((s) => s.kind === "llm");
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
  for (const s of wire) {
    if (s.startedAt < minStart) minStart = s.startedAt;
    const end = s.endedAt ?? s.startedAt;
    if (end > maxEnd) maxEnd = end;
  }
  if (minStart === Infinity) {
    // ponytail: captured non-empty but wire empty would mean an
    // interrupted transform — fall back to captured-side timestamps.
    for (const s of captured) {
      if (s.started_at < minStart) minStart = s.started_at;
      if (s.ended_at && s.ended_at > maxEnd) maxEnd = s.ended_at;
    }
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
    toolSpanCount: captured.filter((s) => s.kind === "tool").length,
    failedCount: countRootFailures(wire),
    humanCount: captured.filter((s) => s.kind === "human").length,
  };
}

// ponytail: failedCount counts ROOT failures only, off the wire so it
// matches what's visible in the waterfall. A failed LLM call fails the
// host node + the kbAgent subgraph + mainAgent — the handler flips
// status on every span in the failure path. Counting every
// status==='failed' would double / triple / quadruple report the same
// logical error.
//
// Rule: a failed span counts when
//   - it's a "leaf" kind (type in {llm, tool, human}), OR
//   - it's a chain/node with NO failed descendant (a real abort that
//     didn't surface as a leaf — markRunningAsFailed sets status on a
//     chain that never produced a child span, and a custom node with
//     no observed downstream fall into this bucket).
function countRootFailures(wire: WireSpanData[]): number {
  const childrenByParent = new Map<string, string[]>();
  for (const s of wire) {
    if (s.parentSpanId !== null) {
      const list = childrenByParent.get(s.parentSpanId) ?? [];
      list.push(s.id);
      childrenByParent.set(s.parentSpanId, list);
    }
  }

  const failedIds = new Set<string>();
  for (const s of wire) {
    if (s.status === "failed") failedIds.add(s.id);
  }

  // ponytail: walk failed spans only — a thread with 200 completed
  // spans and 1 failure does the descendant-walk work once, not 200
  // times. Worst case O(failed × depth), which in practice is small
  // because failure cascades are shallow (kbAgent + mainAgent + ocr
  // node + llm ≤ 4 deep).
  const hasFailedDescendant = (id: string): boolean => {
    const kids = childrenByParent.get(id) ?? [];
    for (const k of kids) {
      if (failedIds.has(k)) return true;
      if (hasFailedDescendant(k)) return true;
    }
    return false;
  };

  let count = 0;
  for (const s of wire) {
    if (s.status !== "failed") continue;
    const isLeaf = s.type === "llm" || s.type === "tool" || s.type === "human";
    if (isLeaf) {
      count += 1;
      continue;
    }
    if (!hasFailedDescendant(s.id)) count += 1;
  }
  return count;
}
