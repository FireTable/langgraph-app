import { describe, it, expect } from "vitest";
import { transformCapturedToSpanData } from "@/lib/observability/transform";
import type { CapturedSpan } from "@/backend/observability/callback-collector";

function makeSpan(overrides: Partial<CapturedSpan>): CapturedSpan {
  // ponytail: every test span gets a default run_id. Production
  // callback-collector stamps meta.run_id on every span (it's the LC
  // runId passed to handleChainStart / etc.). Transform v2 keys
  // steps by run_id so two invokes sharing the same node / step / ns
  // don't collapse — omitting run_id here would silently skip the
  // span. Tests that need multiple invokes override this per-span.
  const defaultMeta = { run_id: "019f30c5-test-run-id" };
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
    ...overrides,
    // ponytail: spread meta separately so overrides.meta merges into
    // the default rather than replacing it whole. `{...overrides}`
    // wins keys that exist at the top level but not for nested
    // objects — TS won't merge those automatically.
    meta: { ...defaultMeta, ...overrides.meta },
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
        span_id: "invoke-1",
        name: "graph.invoke",
        kind: "chain",
        started_at: 1000,
        ended_at: 2000,
        meta: { run_id: "invoke-1" },
      }),
      makeSpan({
        span_id: "__start__-step",
        parent_span_id: "invoke-1",
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
        meta: {
          langgraph_node: "agent",
          langgraph_step: 1,
          langgraph_checkpoint_ns: "ns1",
          run_id: "invoke-1",
        },
      }),
    ]);
    const root = out.find((s) => s.id === "invoke-1");
    expect(root).toBeDefined();
    expect(root?.latencyMs).toBe(1000);
    const agent = out.find((s) => s.id === "step-1-agent-ns1");
    expect(agent?.parentSpanId).toBe("invoke-1");
  });

  it("groups LLM/tool leaves under their step, skipping langsmith noise", () => {
    const out = transformCapturedToSpanData([
      makeSpan({
        span_id: "invoke-1",
        kind: "chain",
        started_at: 50,
        ended_at: 1500,
        meta: { run_id: "invoke-1" },
      }),
      makeSpan({
        span_id: "step",
        kind: "chain",
        started_at: 100,
        ended_at: 1000,
        meta: {
          langgraph_node: "agent",
          langgraph_step: 1,
          langgraph_checkpoint_ns: "ns1",
          run_id: "invoke-1",
        },
      }),
      makeSpan({
        span_id: "llm-real",
        name: "ChatOpenAI",
        kind: "llm",
        started_at: 200,
        ended_at: 900,
        meta: {
          langgraph_node: "agent",
          langgraph_step: 1,
          langgraph_checkpoint_ns: "ns1",
          run_id: "invoke-1",
        },
      }),
      makeSpan({
        span_id: "parser-noise",
        name: "parser",
        kind: "llm",
        started_at: 300,
        ended_at: 400,
        meta: {
          langgraph_node: "agent",
          langgraph_step: 1,
          langgraph_checkpoint_ns: "ns1",
          run_id: "invoke-1",
        },
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
        span_id: "invoke-1",
        kind: "chain",
        started_at: 50,
        ended_at: 1500,
        meta: { run_id: "invoke-1" },
      }),
      makeSpan({
        span_id: "tool-1",
        name: "ask_location",
        kind: "tool",
        started_at: 100,
        ended_at: null,
        status: "waiting",
        meta: {
          langgraph_node: "weatherTools",
          langgraph_step: 3,
          langgraph_checkpoint_ns: "ns3",
          run_id: "invoke-1",
        },
      }),
      makeSpan({
        span_id: "human-1",
        name: "human_input",
        kind: "human",
        started_at: 150,
        ended_at: null,
        status: "waiting",
        meta: {
          langgraph_node: "weatherTools",
          langgraph_step: 3,
          langgraph_checkpoint_ns: "ns3",
          run_id: "invoke-1",
        },
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
        meta: { run_id: "root" },
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

  it("emits a top-level SpanData per real root chain (main + background invokes)", () => {
    // ponytail: regression for the cross-process dispatch case.
    // triggerBackgroundAgentNode calls `client.runs.create(...)`, which fires the
    // background_agent graph in a different runId. Both invokes land in
    // the same thread + parentMessageId and produce a CompiledStateGraph
    // root chain span. The transform must surface them as two sibling
    // top-level chains instead of merging background's steps under the
    // main graph.invoke root (the original synthetic-root bug).
    const BG_ROOT = "019f3099-6fa5-73ca-9c86-fb4780cbbaf1";
    const MAIN_ROOT = "019f3098-dfbe-776d-9091-6767337e006e";
    const out = transformCapturedToSpanData([
      // main invoke root + its step wrappers
      makeSpan({
        span_id: MAIN_ROOT,
        kind: "chain",
        started_at: 1000,
        ended_at: 5000,
        meta: { run_id: MAIN_ROOT },
      }),
      makeSpan({
        span_id: "main-chatagent",
        parent_span_id: MAIN_ROOT,
        kind: "chain",
        started_at: 1100,
        ended_at: 4500,
        meta: {
          langgraph_node: "chatAgent",
          langgraph_step: 2,
          langgraph_checkpoint_ns: "chatAgent:aa",
        },
      }),
      // background invoke root (3s later — matches afterSeconds: 3)
      makeSpan({
        span_id: BG_ROOT,
        kind: "chain",
        started_at: 8000,
        ended_at: 8100,
        meta: { run_id: BG_ROOT },
      }),
      makeSpan({
        span_id: "bg-touch",
        parent_span_id: BG_ROOT,
        kind: "chain",
        started_at: 8010,
        ended_at: 8050,
        meta: {
          run_id: BG_ROOT,
          langgraph_node: "touchLastMessage",
          langgraph_step: 1,
          langgraph_checkpoint_ns: "touchLastMessage:bb",
        },
      }),
      makeSpan({
        span_id: "bg-summarize",
        parent_span_id: BG_ROOT,
        kind: "chain",
        started_at: 8050,
        ended_at: 8090,
        meta: {
          run_id: BG_ROOT,
          langgraph_node: "summarize",
          langgraph_step: 2,
          langgraph_checkpoint_ns: "summarize:cc",
        },
      }),
    ]);
    const mainRoot = out.find((s) => s.startedAt === 1000 && s.parentSpanId === null);
    const bgRoot = out.find((s) => s.startedAt === 8000 && s.parentSpanId === null);
    expect(mainRoot).toBeDefined();
    expect(bgRoot).toBeDefined();
    // ponytail: root name is whatever span.name the LC outer chain
    // fires with (typically `"CompiledStateGraph"` from langgraph-api).
    // We used to infer `agent.invoke` / `backgroundAgent.invoke` from
    // step markers (`summarize` ⇒ background) but that's brittle and
    // mirrors logic that should live in the callback handler when it
    // learns to stamp runName. Test fixtures here don't set name, so
    // expect the default `chain` from makeSpan.
    expect(mainRoot?.name).toBe("chain");
    expect(bgRoot?.name).toBe("chain");
    // both top-level, no synthetic fallback
    expect(out.filter((s) => s.parentSpanId === null)).toHaveLength(2);
    const chatAgent = out.find((s) => s.name === "chatAgent");
    expect(chatAgent?.parentSpanId).toBe(mainRoot?.id);
    const touch = out.find((s) => s.name === "touchLastMessage");
    expect(touch?.parentSpanId).toBe(bgRoot?.id);
    const summarize = out.find((s) => s.name === "summarize");
    expect(summarize?.parentSpanId).toBe(bgRoot?.id);
    // critical: bg steps must NOT leak to main root
    expect(touch?.parentSpanId).not.toBe(mainRoot?.id);
    expect(summarize?.parentSpanId).not.toBe(mainRoot?.id);
  });

  it("splits same-thread same-parent_message_id invokes into separate trees", () => {
    // ponytail: regenerate / follow-up triggers a second main invoke
    // while the previous one's spans are still on disk. Both share
    // thread_id + parent_message_id, so the API query surfaces them
    // together. Without run_id in the step key, both invokes'
    // __start__ / routerAgent steps would collapse into one merged
    // step and the waterfall would show a tangled tree. Each invoke
    // must own its own step instances.
    const INVOKE_A = "019f30c5-aaaa-7427-862e-a54639d17178";
    const INVOKE_B = "019f30c5-bbbb-7550-9363-393e73cdd607";
    const out = transformCapturedToSpanData([
      // invoke A — root + __start__ + routerAgent
      makeSpan({
        span_id: INVOKE_A,
        kind: "chain",
        started_at: 1000,
        ended_at: 5000,
        meta: { run_id: INVOKE_A },
      }),
      makeSpan({
        span_id: `${INVOKE_A}-start`,
        parent_span_id: `${INVOKE_A}-root`,
        kind: "chain",
        started_at: 1100,
        ended_at: 1200,
        meta: {
          run_id: INVOKE_A,
          langgraph_node: "__start__",
          langgraph_step: 0,
          langgraph_checkpoint_ns: "__start__:uuid-A",
        },
      }),
      makeSpan({
        span_id: `${INVOKE_A}-router`,
        parent_span_id: `${INVOKE_A}-root`,
        kind: "chain",
        started_at: 1300,
        ended_at: 4500,
        meta: {
          run_id: INVOKE_A,
          langgraph_node: "routerAgent",
          langgraph_step: 1,
          langgraph_checkpoint_ns: "routerAgent:uuid-A",
        },
      }),
      // invoke B — root + __start__ + routerAgent (same nodes, different uuids)
      makeSpan({
        span_id: INVOKE_B,
        kind: "chain",
        started_at: 10000,
        ended_at: 14000,
        meta: { run_id: INVOKE_B },
      }),
      makeSpan({
        span_id: `${INVOKE_B}-start`,
        parent_span_id: `${INVOKE_B}-root`,
        kind: "chain",
        started_at: 10100,
        ended_at: 10200,
        meta: {
          run_id: INVOKE_B,
          langgraph_node: "__start__",
          langgraph_step: 0,
          langgraph_checkpoint_ns: "__start__:uuid-B",
        },
      }),
      makeSpan({
        span_id: `${INVOKE_B}-router`,
        parent_span_id: `${INVOKE_B}-root`,
        kind: "chain",
        started_at: 10300,
        ended_at: 13500,
        meta: {
          run_id: INVOKE_B,
          langgraph_node: "routerAgent",
          langgraph_step: 1,
          langgraph_checkpoint_ns: "routerAgent:uuid-B",
        },
      }),
    ]);
    const roots = out.filter((s) => s.parentSpanId === null);
    expect(roots).toHaveLength(2);
    // ponytail: root names fall through to span.name (default `"chain"`
    // in makeSpan) now that InvokeKind inference is gone. The structural
    // guarantee — 2 sibling top-level chains — is what we guard here;
    // labelling `agent.invoke` vs `backgroundAgent.invoke` is the
    // callback handler's job once handleChainStart's param order is
    // fixed and meta.run_name gets stamped.
    expect(roots.map((r) => r.name).sort()).toEqual(["chain", "chain"]);
    // ponytail: 2 invokes × 2 steps (__start__ + routerAgent) = 4 step
    // rows. Without run_id in the key, both __start__ spans collapse
    // into one merged step and we see only 2 step rows — which is the
    // bug we're guarding against.
    const stepRows = out.filter((s) => s.type === "node" || s.type === "chain");
    expect(stepRows).toHaveLength(6); // 2 roots + 4 steps
    const startSteps = stepRows.filter((s) => s.name === "__start__");
    expect(startSteps).toHaveLength(2);
    const routerSteps = stepRows.filter((s) => s.name === "routerAgent");
    expect(routerSteps).toHaveLength(2);
    // each __start__ step's parentSpanId must be its own invoke's root
    // (NOT the other invoke's root). ns prefix is different across
    // invokes (uuid-A vs uuid-B), so parentIdFor can only match
    // within the same invoke.
    const rootA = roots.find((r) => r.startedAt === 1000)!;
    const rootB = roots.find((r) => r.startedAt === 10000)!;
    expect(
      startSteps.every((s) => s.parentSpanId === rootA.id || s.parentSpanId === rootB.id),
    ).toBe(true);
    // exactly one __start__ is parented to each root — cross-invoke leak
    const aChildren = stepRows.filter((s) => s.parentSpanId === rootA.id).map((s) => s.name);
    const bChildren = stepRows.filter((s) => s.parentSpanId === rootB.id).map((s) => s.name);
    expect(aChildren.sort()).toEqual(["__start__", "routerAgent"]);
    expect(bChildren.sort()).toEqual(["__start__", "routerAgent"]);
  });

  it("uses full span_id for root chain SpanData.id (UUIDv7 short-prefix collision guard)", () => {
    // ponytail: LangGraph emits runId as UUIDv7. Two invokes fired
    // within the same timestamp prefix (e.g. a chat invoke and a
    // background `runs.create` dispatch seconds apart) share their
    // first 8–12 hex characters. Truncating the span_id into the
    // SpanData.id (`chain-<short>`) collapses two distinct invokes
    // into one top-level entry and the panel renders their steps
    // under the wrong root. The fix is the full span_id — UUIDs are
    // unique by construction, no slicing required.
    const MAIN_ROOT = "019f30b3-8e60-7427-862e-a54639d17178";
    const BG_ROOT = "019f30b3-ef76-7550-9363-393e73cdd607";
    const out = transformCapturedToSpanData([
      makeSpan({
        span_id: MAIN_ROOT,
        kind: "chain",
        started_at: 1783228501654,
        ended_at: 1783228526458,
        meta: { run_id: MAIN_ROOT },
      }),
      makeSpan({
        span_id: "main-step",
        parent_span_id: MAIN_ROOT,
        kind: "chain",
        started_at: 1783228501660,
        ended_at: 1783228526450,
        meta: {
          run_id: MAIN_ROOT,
          langgraph_node: "routerAgent",
          langgraph_step: 1,
          langgraph_checkpoint_ns: "routerAgent:real",
        },
      }),
      makeSpan({
        span_id: BG_ROOT,
        kind: "chain",
        started_at: 1783228529600,
        ended_at: 1783228529616,
        meta: { run_id: BG_ROOT },
      }),
      makeSpan({
        span_id: "bg-step",
        parent_span_id: BG_ROOT,
        kind: "chain",
        started_at: 1783228529605,
        ended_at: 1783228529610,
        meta: {
          run_id: BG_ROOT,
          langgraph_node: "touchLastMessage",
          langgraph_step: 1,
          langgraph_checkpoint_ns: "touchLastMessage:real",
        },
      }),
    ]);
    const roots = out.filter((s) => s.parentSpanId === null);
    expect(roots).toHaveLength(2);
    const ids = new Set(roots.map((r) => r.id));
    expect(ids.size).toBe(2);
    // both ids include the FULL UUID, not a slice
    expect([...ids]).toEqual(expect.arrayContaining([MAIN_ROOT, BG_ROOT]));
  });

  it("surfaces a real root chain's name from span.name when no kind is inferred", () => {
    // ponytail: post-InvokeKind-removal companion to the main + bg test
    // above. We don't infer `agent.invoke` here — we fall through to
    // span.name (default `"chain"` from makeSpan) since runName hasn't
    // landed in the callback handler yet. The point of this test now
    // is: a lone root chain still anchors the tree (not the synthetic
    // `graph.invoke` fallback), which means the parent loop can hang
    // real steps off it instead of parking them at `root`.
    const out = transformCapturedToSpanData([
      makeSpan({
        span_id: "root-main",
        kind: "chain",
        started_at: 1000,
        ended_at: 5000,
        meta: { run_id: "root-main" },
      }),
      makeSpan({
        span_id: "step-router",
        parent_span_id: "root-main",
        kind: "chain",
        started_at: 1100,
        ended_at: 1200,
        meta: {
          langgraph_node: "routerAgent",
          langgraph_step: 1,
          langgraph_checkpoint_ns: "routerAgent:aa",
        },
      }),
      makeSpan({
        span_id: "step-chat",
        parent_span_id: "root-main",
        kind: "chain",
        started_at: 1300,
        ended_at: 4500,
        meta: {
          langgraph_node: "chatAgent",
          langgraph_step: 2,
          langgraph_checkpoint_ns: "chatAgent:bb",
        },
      }),
    ]);
    const root = out.find((s) => s.parentSpanId === null);
    expect(root?.name).toBe("chain");
  });

  it("drops orphan steps when no real root chain span is present", () => {
    // ponytail: legacy / partial captures without an outermost wrapper
    // (dev fixtures, regression captures missing their outer chain
    // start) used to fall back to a synthetic `graph.invoke` root and
    // park the step under it. Now we just drop the orphan — partial
    // data shouldn't fabricate a tree.
    const out = transformCapturedToSpanData([
      makeSpan({
        span_id: "agent-step",
        kind: "chain",
        started_at: 1100,
        ended_at: 1900,
        meta: {
          langgraph_node: "agent",
          langgraph_step: 1,
          langgraph_checkpoint_ns: "ns1",
        },
      }),
    ]);
    expect(out).toEqual([]);
  });
});
