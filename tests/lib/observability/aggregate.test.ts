import { describe, expect, it } from "vitest";

import type { CapturedSpan } from "@/lib/observability/callback";
import type { WireSpanData } from "@/lib/observability/transform";
import { aggregateRoot } from "@/lib/observability/aggregate";

// ponytail: the root-aggregate FAILED card must count root-cause
// failures, not chain propagations. A failed LLM call fails its host
// chain + the node that ran it + the kbAgent subgraph + mainAgent —
// four spans share one cause. The user only wants the count of unique
// failures: each failed leaf (llm/tool/human) plus each failed
// chain/node that has no failed descendant (real abort).
//
// aggregateRoot now takes BOTH arrays — token / TTFT / span-count
// fields stay on CapturedSpan; the failedCount rule reads from
// WireSpanData because the waterfall shape carries the parent links
// the rule needs without re-deriving them from CapturedSpan each call.

function cap(overrides: Partial<CapturedSpan> & { span_id: string }): CapturedSpan {
  return {
    span_id: overrides.span_id,
    parent_span_id: overrides.parent_span_id ?? null,
    name: overrides.name ?? "s",
    kind: overrides.kind ?? "node",
    status: overrides.status ?? "completed",
    started_at: overrides.started_at ?? 0,
    ended_at: overrides.ended_at ?? 100,
    input: overrides.input ?? null,
    output: overrides.output ?? null,
    usage: overrides.usage ?? null,
    error: overrides.error ?? null,
    meta: overrides.meta ?? {},
  };
}

// ponytail: project a CapturedSpan-shaped test fixture into WireSpanData.
// CapturedSpan.kind is an enum; SpanData.type is a plain string — type
// narrowing in the rule is "llm" / "tool" / "human" matching. SpanData
// doesn't carry CapturedSpan's "waiting" enum value — production code
// reaches this state via interrupt() yields. Tests stick to the four
// canonical statuses the rule cares about.
function wire(o: Partial<CapturedSpan> & { span_id: string }): WireSpanData {
  const status = (o.status ?? "completed") as WireSpanData["status"];
  return {
    id: o.span_id,
    parentSpanId: o.parent_span_id ?? null,
    name: o.name ?? "s",
    type: o.kind ?? "node",
    status,
    startedAt: o.started_at ?? 0,
    endedAt: o.ended_at ?? 100,
    latencyMs: null,
  };
}

function fixture(items: Array<Partial<CapturedSpan> & { span_id: string }>) {
  return {
    captured: items.map(cap),
    wire: items.map(wire),
  };
}

describe("aggregateRoot — failedCount", () => {
  it("counts a single failed LLM span as 1 even when its parent chain + node inherit 'failed'", () => {
    // kbAgent → ocr node → llm(api) failure stack, with mainAgent chain
    // wrapping kbAgent. The LLM call threw; the handler flips status on
    // every span in the failure path.
    const f = fixture([
      { span_id: "main", parent_span_id: null, kind: "chain", status: "failed" },
      { span_id: "kb", parent_span_id: "main", kind: "chain", status: "failed" },
      { span_id: "ocr", parent_span_id: "kb", kind: "node", status: "failed" },
      {
        span_id: "llm-1",
        parent_span_id: "ocr",
        kind: "llm",
        status: "failed",
        meta: { time_to_first_token_ms: null },
      },
    ]);
    const agg = aggregateRoot(f.captured, f.wire);
    expect(agg).not.toBeNull();
    expect(agg!.failedCount).toBe(1);
  });

  it("counts a failed tool span the same way (leaf = unique failure)", () => {
    const f = fixture([
      { span_id: "chain-1", parent_span_id: null, kind: "chain", status: "failed" },
      { span_id: "tool-1", parent_span_id: "chain-1", kind: "tool", status: "failed" },
    ]);
    expect(aggregateRoot(f.captured, f.wire)!.failedCount).toBe(1);
  });

  it("counts each failed leaf separately when they share a parent chain", () => {
    const f = fixture([
      { span_id: "chain-1", parent_span_id: null, kind: "chain", status: "failed" },
      {
        span_id: "llm-1",
        parent_span_id: "chain-1",
        kind: "llm",
        status: "failed",
        meta: { time_to_first_token_ms: null },
      },
      {
        span_id: "llm-2",
        parent_span_id: "chain-1",
        kind: "llm",
        status: "failed",
        meta: { time_to_first_token_ms: null },
      },
    ]);
    expect(aggregateRoot(f.captured, f.wire)!.failedCount).toBe(2);
  });

  it("counts a failed chain with no descendants as 1 (real abort)", () => {
    const f = fixture([
      { span_id: "chain-1", parent_span_id: null, kind: "chain", status: "failed" },
    ]);
    expect(aggregateRoot(f.captured, f.wire)!.failedCount).toBe(1);
  });

  it("counts 0 when no span is failed (regression guard for the new rule)", () => {
    const f = fixture([
      { span_id: "chain-1", parent_span_id: null, kind: "chain", status: "completed" },
      {
        span_id: "llm-1",
        parent_span_id: "chain-1",
        kind: "llm",
        status: "completed",
        meta: { time_to_first_token_ms: 12 },
      },
    ]);
    expect(aggregateRoot(f.captured, f.wire)!.failedCount).toBe(0);
  });

  it("returns the right count across a realistic kbAgent failure cascade: 1 LLM + 1 chain that owns it", () => {
    const f = fixture([
      { span_id: "main", parent_span_id: null, kind: "chain", status: "completed" },
      { span_id: "kb", parent_span_id: "main", kind: "chain", status: "failed" },
      { span_id: "screenshot", parent_span_id: "kb", kind: "node", status: "completed" },
      { span_id: "ocr", parent_span_id: "kb", kind: "node", status: "failed" },
      {
        span_id: "llm-ocr",
        parent_span_id: "ocr",
        kind: "llm",
        status: "failed",
        meta: { time_to_first_token_ms: null },
      },
    ]);
    // ocr (failed, has failed descendant llm-ocr) → not counted (propagation)
    // kb (failed, has failed descendant ocr) → not counted (propagation)
    // llm-ocr (failed leaf) → 1
    expect(aggregateRoot(f.captured, f.wire)!.failedCount).toBe(1);
  });
});
