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

  it("nests inner-subgraph steps under the wrapper step (parentIdFor uses ns prefix, not step number)", () => {
    // ponytail: regression guard for a real production bug. With
    // USE_SUBGRAPH=true, every wrapper chain (tools RunnableSequence,
    // inner CompiledStateGraph, outer RunnableSequence) shares the same
    // langgraph_node="weatherAgent" + step=2 + ns="weatherAgent:<uuid>".
    // When `interrupt()` fires inside the subgraph, the model step's
    // earliest raw span ends up being the ChatOpenAI whose
    // parent_span_id resolves to the model RunnableSequence wrapper
    // (same step). The old parentIdFor then skipped the weatherAgent
    // wrapper because of `candidate.step >= s.step` — weatherAgent has
    // step=2, model has step=1, so weatherAgent was filtered out. The
    // model step landed at parent="root" and the panel showed it as a
    // sibling of weatherAgent instead of nested under it.
    //
    // The IDs / timestamps below mirror a real captured batch from
    // 2026-07-04 — RunnableSequence and ChatOpenAI share the exact
    // same started_at so the sort is stable on original array order.
    // We put ChatOpenAI first to reproduce the production case where
    // the wrapped LLM's run_id sorts ahead of the wrapper Runnable.
    const WA_NS = "weatherAgent:abc-123";
    const MODEL_NS = `${WA_NS}|model:def-456`;
    const out = transformCapturedToSpanData([
      makeSpan({
        span_id: "root",
        kind: "chain",
        started_at: 1000,
        ended_at: 5000,
        meta: {},
      }),
      makeSpan({
        span_id: "wa-outer",
        parent_span_id: "root",
        name: "RunnableSequence",
        kind: "chain",
        started_at: 1100,
        ended_at: 4500,
        meta: { langgraph_node: "weatherAgent", langgraph_step: 2, langgraph_checkpoint_ns: WA_NS },
      }),
      makeSpan({
        span_id: "wa-inner",
        parent_span_id: "wa-outer",
        name: "CompiledStateGraph",
        kind: "chain",
        started_at: 1110,
        ended_at: 4400,
        meta: { langgraph_node: "weatherAgent", langgraph_step: 2, langgraph_checkpoint_ns: WA_NS },
      }),
      // ChatOpenAI listed BEFORE RunnableSequence — same started_at.
      // Transform's stable sort preserves this order; ChatOpenAI ends
      // up as repRaw, and its parent_span_id (= model RunnableSequence)
      // resolves to the SAME model step (parentStep === step). That's
      // the exact production failure path.
      makeSpan({
        span_id: "model-llm",
        parent_span_id: "model-rs",
        name: "ChatOpenAI",
        kind: "llm",
        started_at: 1200,
        ended_at: 2900,
        meta: { langgraph_node: "model", langgraph_step: 1, langgraph_checkpoint_ns: MODEL_NS },
      }),
      makeSpan({
        span_id: "model-rs",
        parent_span_id: "wa-inner",
        name: "RunnableSequence",
        kind: "chain",
        started_at: 1200,
        ended_at: 3000,
        meta: { langgraph_node: "model", langgraph_step: 1, langgraph_checkpoint_ns: MODEL_NS },
      }),
    ]);
    const modelStep = out.find((s) => s.name === "model");
    expect(modelStep).toBeDefined();
    const weatherAgentStep = out.find((s) => s.name === "weatherAgent");
    expect(weatherAgentStep).toBeDefined();
    // model must be nested under the (deduped) weatherAgent step, NOT
    // pinned at root. The old code returned "root" here because
    // repRaw.parent_span_id resolved to model-rs (same step) and the
    // step-number fallback couldn't find weatherAgent.
    expect(modelStep?.parentSpanId).toBe(weatherAgentStep?.id);
  });
});
