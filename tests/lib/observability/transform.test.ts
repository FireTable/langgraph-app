import { describe, it, expect } from "vitest";
import { transformCapturedToSpanData } from "@/lib/observability/transform";
import type { CapturedSpan } from "@/backend/observability/callback-collector";

function makeSpan(overrides: Partial<CapturedSpan>): CapturedSpan {
  return {
    span_id: "id",
    parent_span_id: null,
    name: "chain",
    kind: "chain",
    status: "completed",
    started_at: 0,
    ended_at: 0,
    input: null,
    output: null,
    usage: null,
    error: null,
    meta: {},
    ...overrides,
  };
}

describe("transformCapturedToSpanData", () => {
  it("returns an empty array when there are no tagged steps", () => {
    const spans: CapturedSpan[] = [makeSpan({ span_id: "orphan" })];
    expect(transformCapturedToSpanData(spans)).toEqual([]);
  });

  it("emits a root SpanData plus one entry per step", () => {
    const out = transformCapturedToSpanData([
      makeSpan({
        span_id: "root",
        name: "graph.invoke",
        kind: "chain",
        started_at: 1000,
        ended_at: 2000,
        meta: { langgraph_node: "__start__", langgraph_step: 0, langgraph_checkpoint_ns: "" },
      }),
      makeSpan({
        span_id: "agent-step",
        name: "agent",
        kind: "node",
        started_at: 1100,
        ended_at: 1900,
        meta: { langgraph_node: "agent", langgraph_step: 1, langgraph_checkpoint_ns: "ns1" },
      }),
    ]);
    const root = out.find((s) => s.id === "root");
    expect(root).toBeDefined();
    expect(root?.latencyMs).toBe(1000);
    const agent = out.find((s) => s.id === "step-1-agent-ns1");
    expect(agent?.parentSpanId).toBe("root");
  });

  it("groups LLM/tool leaves under their step, skipping langsmith noise", () => {
    const out = transformCapturedToSpanData([
      makeSpan({
        span_id: "step",
        kind: "chain",
        started_at: 100,
        ended_at: 1000,
        meta: { langgraph_node: "agent", langgraph_step: 1, langgraph_checkpoint_ns: "ns1" },
      }),
      makeSpan({
        span_id: "llm-real",
        name: "ChatOpenAI",
        kind: "llm",
        started_at: 200,
        ended_at: 900,
        meta: { langgraph_node: "agent", langgraph_step: 1, langgraph_checkpoint_ns: "ns1" },
      }),
      makeSpan({
        span_id: "parser-noise",
        name: "parser",
        kind: "llm",
        started_at: 300,
        ended_at: 400,
        meta: { langgraph_node: "agent", langgraph_step: 1, langgraph_checkpoint_ns: "ns1" },
      }),
    ]);
    const step = out.find((s) => s.id === "step-1-agent-ns1");
    const children = out.filter((s) => s.parentSpanId === step?.id);
    expect(children.map((c) => c.id)).toEqual(["llm-real"]);
  });

  it("includes kind=human leaves so synthetic interrupt spans surface in the panel", () => {
    // ponytail: CapturingHandler.handleToolError inserts a sibling
    // `kind: "human"` span when `interrupt()` fires. Without this filter
    // exemption the panel would show two ask_location bars with no
    // gap marker — exactly what the user reported before this fix.
    const out = transformCapturedToSpanData([
      makeSpan({
        span_id: "tool-1",
        name: "ask_location",
        kind: "tool",
        started_at: 100,
        ended_at: null,
        status: "waiting",
        meta: { langgraph_node: "weatherTools", langgraph_step: 3, langgraph_checkpoint_ns: "ns3" },
      }),
      makeSpan({
        span_id: "human-1",
        name: "human_input",
        kind: "human",
        started_at: 150,
        ended_at: null,
        status: "waiting",
        meta: { langgraph_node: "weatherTools", langgraph_step: 3, langgraph_checkpoint_ns: "ns3" },
      }),
    ]);
    const step = out.find((s) => s.id === "step-3-weatherTools-ns3");
    const children = out.filter((s) => s.parentSpanId === step?.id);
    expect(children.map((c) => c.id).sort()).toEqual(["human-1", "tool-1"]);
    // waiting → running mapping kicks in for the panel.
    const human = children.find((c) => c.id === "human-1");
    expect(human?.status).toBe("running");
  });
});
