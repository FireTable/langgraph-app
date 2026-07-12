// ponytail: transforms CapturedSpan[] (callback handler output) into the
// SpanData[] shape that @assistant-ui/react-o11y consumes, plus a list of
// "wrapper" node names (subgraphs) for the chip label.
//
// Parent chain comes from the backend (CapturingHandler in
// backend/observability/callback.ts), which derives it from
// langgraph_checkpoint_ns. The frontend does not recompute parents.
import type { SpanData } from "@assistant-ui/react-o11y";
import type { CapturedSpan } from "@/lib/observability/callback";

// ponytail: extend the @assistant-ui/react-o11y SpanData with our
// per-turn id. The upstream type is strict (no extra fields), so we
// type-extend here rather than passing a separate map from the API.
// The panel reads `parentMessageId` off the row it clicked to build
// the per-turn detail URL.
export type WireSpanData = SpanData & { parentMessageId?: string };

// ponytail: read the turn id from a span's meta. The callback handler
// stamps `meta.parent_message_id`; queries.ts also projects it into a
// column and re-hydrates on read, so the meta is the canonical source.
function readPmid(span: CapturedSpan | undefined): string | undefined {
  if (!span) return undefined;
  const raw = (span.meta as Record<string, unknown> | null | undefined)?.parent_message_id;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function readPmidFromLeaves(leaves: CapturedSpan[]): string | undefined {
  for (const l of leaves) {
    const v = readPmid(l);
    if (v) return v;
  }
  return undefined;
}

type Step = {
  step: number;
  node: string;
  ns: string;
  // ponytail: the LC run id the step belongs to. CapturingHandler
  // stamps meta.run_id on every span — main invokes and the
  // background_agent dispatch each get their own UUID, so a step's
  // run_id is the unambiguous identifier of "which invoke does this
  // step belong to". Two invokes triggered in the same thread + same
  // parent_message_id (regenerate, follow-up) share langgraph_node /
  // step / ns — without run_id in the key they collapse into one
  // merged step, which is what made the panel flatten multiple
  // invoke trees into a single waterfall row.
  run_id: string;
  started: number;
  ended: number | null;
  leaves: CapturedSpan[];
};

function stepKey(s: Step): string {
  return `${s.run_id}::${s.ns}::${s.step}::${s.node}`;
}

const LANGSMITH_NOISE = new Set(["RunnableSequence", "RunnableLambda", "parser"]);

// ponytail: a root chain span is a kind=chain callback with no
// langgraph_node / langgraph_step (it's the outermost compiled graph
// wrapper, fired before any step's START). One per invoke — main chat
// graph fires one, the background_agent graph fires another when
// `runs.create` triggers it. Identifying them lets the panel render
// sibling invoke trees (`graph.invoke` + `backgroundGraph.invoke`) at
// the top level instead of flattening both into one synthetic root.
//
// IDs use the full span_id — UUIDv7 shares a timestamp prefix across
// invokes fired within ~seconds of each other, so any slice(0, N)
// collides. The full UUID is the only unique guarantee.
type RootChain = { span: CapturedSpan; id: string };

function collectRootChains(captured: CapturedSpan[]): RootChain[] {
  // ponytail: dedupe by meta.run_id. Under subgraphs:true LC can fire
  // an inner CompiledStateGraph wrapper chain whose meta has been
  // re-stamped so span_id === meta.run_id holds for it too — same
  // shape as the real root. The outer wrapper fires first and wins;
  // subsequent duplicates for the same run_id are dropped. Two main
  // invokes both having parent_span_id "agent" (the compile name) are
  // NOT collapsed here because their meta.run_id differs.
  const roots = new Map<string, RootChain>();
  for (const s of captured) {
    if (
      s.kind !== "chain" ||
      s.span_id !== s.meta?.run_id ||
      s.parent_span_id == null ||
      typeof s.meta?.langgraph_node === "string" ||
      typeof s.meta?.langgraph_step === "number"
    )
      continue;
    const parentSpanId = s.parent_span_id as string;

    if (roots.has(parentSpanId)) continue;
    roots.set(parentSpanId, { span: s, id: s.span_id });
  }
  return [...roots.values()].sort((a, b) => a.span.started_at - b.span.started_at);
}

function rootIdFromSpanId(spanId: string, roots: RootChain[]): string | null {
  return roots.find((r) => r.span.span_id === spanId)?.id ?? null;
}

export function transformCapturedToSpanData(captured: CapturedSpan[]): WireSpanData[] {
  const stepMap = new Map<string, Step>();
  for (const s of captured) {
    const node = s.meta?.langgraph_node;
    const step = s.meta?.langgraph_step;
    if (typeof node !== "string" || typeof step !== "number") continue;
    const ns =
      typeof s.meta?.langgraph_checkpoint_ns === "string" ? s.meta.langgraph_checkpoint_ns : "";
    const runId = typeof s.meta?.run_id === "string" ? s.meta.run_id : "";
    if (!runId) continue;
    const key = stepKey({ step, node, ns, run_id: runId, started: 0, ended: null, leaves: [] });
    const bucket = stepMap.get(key) ?? {
      step,
      node,
      ns,
      run_id: runId,
      started: s.started_at,
      ended: s.ended_at,
      leaves: [] as CapturedSpan[],
    };
    if (s.started_at < bucket.started) bucket.started = s.started_at;
    if (s.ended_at && (!bucket.ended || s.ended_at > bucket.ended)) bucket.ended = s.ended_at;
    if (
      (s.kind === "llm" || s.kind === "tool" || s.kind === "human") &&
      !LANGSMITH_NOISE.has(s.name)
    ) {
      bucket.leaves.push(s);
    }
    stepMap.set(key, bucket);
  }

  const steps = [...stepMap.values()].sort((a, b) => a.started - b.started || a.step - b.step);
  if (steps.length === 0) return [];

  // ponytail: real root chains (one per invoke — main chat + any background
  // dispatches via runs.create) become their own top-level SpanData. No
  // synthetic fallback when none exist — the panel just shows the roots
  // that are there and drops orphaned steps.
  const rootChains = collectRootChains(captured);

  // ponytail: every step's meta.run_id matches the run_id of its invoke's
  // outermost chain — and collectRootChains keyed each root by that same
  // span_id. Returns null when no root chain matches the step's invoke:
  // partial / fixture captures without an outermost wrapper shouldn't
  // synthesize a "graph.invoke" root and shouldn't fall back to the first
  // root either (that flattened cross-invoke steps under main).
  const rootIdByRunId = new Map<string, string>();
  for (const r of rootChains) rootIdByRunId.set(r.span.span_id, r.id);
  const rootForStep = (s: Step): string | null => rootIdByRunId.get(s.run_id) ?? null;

  // ponytail: build a lookup from span_id (raw) to its Step. The backend
  // sets parent_span_id to the runId of the parent Step — but the same Step
  // may have multiple raw spans (chain wrapper + leaves). We index by ANY
  // span_id that lands inside a step, so the next-pass lookup always hits.
  const stepBySpanId = new Map<string, Step>();
  for (const s of captured) {
    const node = s.meta?.langgraph_node;
    const step = s.meta?.langgraph_step;
    const ns =
      typeof s.meta?.langgraph_checkpoint_ns === "string" ? s.meta.langgraph_checkpoint_ns : "";
    const runId = typeof s.meta?.run_id === "string" ? s.meta.run_id : "";
    if (typeof node !== "string" || typeof step !== "number" || !runId) continue;
    const k = stepKey({ step, node, ns, run_id: runId, started: 0, ended: null, leaves: [] });
    const bucket = stepMap.get(k);
    if (bucket) stepBySpanId.set(s.span_id, bucket);
  }

  // ponytail: build the top-level SpanData list. One entry per real root
  // chain (main + each background dispatch). No synthetic fallback —
  // steps whose run_id has no matching root are dropped from the panel.
  const rootEntries: WireSpanData[] = rootChains.map<WireSpanData>((r) => ({
    id: r.id,
    parentSpanId: null,
    // ponytail: span.name comes from the LC outer RunnableSequence
    // wrapper langgraph-api fires around our Pregel call. The
    // `runName` arg of handleChainStart is what we'd ideally use
    // (compile({ name: "agent" }) sets Pregel.this.name upstream),
    // but the wrapper doesn't carry it through yet — CapturingHandler
    // (see backend/observability/callback.ts) needs to
    // stamp meta.run_name when the param order is fixed. Until then
    // we render whatever LC gave us, with `graph.invoke` as the
    // last-resort label for dev fixtures / partial captures.
    name: r.span.parent_span_id || r.span.name || "graph.invoke",
    type: "chain",
    // ponytail: same status normalization as the leaf loop below —
    // SpanData's union has no "waiting" so DB-side waiting (interrupted
    // background run) renders as "running" for the panel.
    status: r.span.status === "waiting" ? "running" : r.span.status,
    startedAt: r.span.started_at,
    endedAt: r.span.ended_at,
    latencyMs: r.span.ended_at != null ? r.span.ended_at - r.span.started_at : null,
    // ponytail: turn id on every SpanData so the panel can build the
    // per-turn detail URL. Reads from the root chain's own meta
    // (re-hydrated from the column in queries.ts).
    parentMessageId: readPmid(r.span),
  }));

  const stepIdByStepAndName = new Map<string, string>();
  for (const step of steps) {
    const safeNs = step.ns.replace(/[^a-z0-9]/gi, "");
    stepIdByStepAndName.set(stepKey(step), `step-${step.step}-${step.node}-${safeNs}`);
  }

  const wrapperCandidates = collectWrapperCandidates(captured);

  const out: WireSpanData[] = [...rootEntries];
  // ponytail: SpanResource walks spans by parent_span_id. Anchor each
  // step's parent at the nearest strictly-outer step (a shorter ns whose
  // ns is a strict prefix of the child's ns), or root. Picking by ns
  // prefix — not by step number — matters under USE_SUBGRAPH=true: a
  // compiled subgraph's wrapper chain has langgraph_step higher than its
  // inner steps (the outer RunnableSequence fires after the inner
  // CompiledStateGraph ends, etc.), so a `candidate.step >= s.step`
  // skip would miss the wrapper entirely and the inner step would land
  // at "root". Tie-break by the longest matching ns so the innermost
  // wrapper wins when the same step nests inside multiple ancestors
  // (none of which happens today, but the comment is the cheap shape).
  const parentIdFor = (s: Step): string | null => {
    let best: Step | null = null;
    let bestLen = -1;
    for (const candidate of steps) {
      if (candidate === s) continue;
      if (s.ns === candidate.ns) continue;
      if (!s.ns.startsWith(`${candidate.ns}|`)) continue;
      if (candidate.ns.length > bestLen) {
        best = candidate;
        bestLen = candidate.ns.length;
      }
    }
    if (best) return stepIdByStepAndName.get(stepKey(best)) ?? rootForStep(s);
    return rootForStep(s);
  };
  for (const step of steps) {
    const id = stepIdByStepAndName.get(stepKey(step))!;
    const repRaw = [...captured]
      .filter((s) => {
        const n = s.meta?.langgraph_node;
        const st = s.meta?.langgraph_step;
        const sn =
          typeof s.meta?.langgraph_checkpoint_ns === "string" ? s.meta.langgraph_checkpoint_ns : "";
        const sr = typeof s.meta?.run_id === "string" ? s.meta.run_id : "";
        // ponytail: pin repRaw to THIS invoke's run_id. Without it, a
        // step shared across two main invokes (same node / step / ns)
        // would grab the first invoke's earliest span as its repRaw,
        // and that span's parent_span_id would point at the FIRST
        // root chain — every later invoke's step would get parented
        // to the wrong root.
        return n === step.node && st === step.step && sn === step.ns && sr === step.run_id;
      })
      .sort((a, b) => a.started_at - b.started_at)[0];
    let parentId: string | null = rootForStep(step);
    if (repRaw?.parent_span_id) {
      // ponytail: if the step's parent in callback-land is a real root
      // chain (different invoke — e.g. background_agent triggered via
      // runs.create), anchor it under THAT root, not under the synthetic
      // default. Without this, every cross-invoke step falls to the
      // fallback and the panel flattens two trees into one.
      const rootAnchor = rootIdFromSpanId(repRaw.parent_span_id, rootChains);
      if (rootAnchor) {
        parentId = rootAnchor;
      } else {
        const parentStep = stepBySpanId.get(repRaw.parent_span_id);
        if (parentStep && parentStep !== step) {
          parentId = stepIdByStepAndName.get(stepKey(parentStep)) ?? rootForStep(step);
        } else {
          parentId = parentIdFor(step);
        }
      }
    } else {
      parentId = parentIdFor(step);
    }
    // ponytail: no matching root chain → drop the step entirely. Partial
    // captures / dev fixtures without an outermost wrapper shouldn't
    // dangle under a synthetic "root" entry.
    if (parentId === null) continue;
    const type = stepHasInner(step, wrapperCandidates) ? "chain" : "node";
    // ponytail: surface the turn id on every SpanData so the panel can
    // build the per-turn detail URL without re-deriving from the
    // waterfall tree. Prefer the repRaw (earliest) span's meta; fall
    // back to any leaf if the repRaw didn't carry it.
    const stepPmid = readPmid(repRaw) ?? readPmidFromLeaves(step.leaves);
    out.push({
      id,
      parentSpanId: parentId,
      name: step.node,
      type,
      status: step.ended ? "completed" : "running",
      startedAt: step.started,
      endedAt: step.ended,
      latencyMs: step.ended ? step.ended - step.started : null,
      parentMessageId: stepPmid,
    });
    for (const leaf of step.leaves) {
      // ponytail: LLM leaves surface the model name in the waterfall
      // (`gpt-4o-mini` reads better than the LangChain class name
      // `ChatOpenAI` — especially when a thread hops between
      // providers). Pull from meta.ls_model_name; fall back to the
      // span name when the provider didn't stamp it.
      const leafMeta = (leaf.meta ?? null) as Record<string, unknown> | null;
      const modelName = leaf.kind === "llm" ? leafMeta?.ls_model_name : null;
      const leafName =
        typeof modelName === "string" && modelName.length > 0 ? modelName : leaf.name;
      out.push({
        id: leaf.span_id,
        parentSpanId: id,
        name: leafName,
        type: leaf.kind === "llm" ? "llm" : leaf.kind === "tool" ? "tool" : leaf.kind,
        // ponytail: SpanData.status from @assistant-ui/react-o11y only
        // accepts "running" | "completed" | "failed" | "skipped" — no
        // "waiting". Map DB-side `waiting` (LangGraph interrupt) to
        // `running` so the panel keeps ticking the open duration. The
        // synthetic human span alongside the tool conveys the interrupt
        // semantically; the DB row keeps the precise status for queries.
        status: leaf.status === "waiting" ? "running" : leaf.status,
        startedAt: leaf.started_at,
        endedAt: leaf.ended_at,
        latencyMs: leaf.ended_at ? leaf.ended_at - leaf.started_at : null,
        parentMessageId: readPmid(leaf) ?? stepPmid,
      });
    }
  }

  return clampCycles(out);
}

// ponytail: synthetic step-wrapper id → representative raw span_id.
// Used by the panel to translate a clicked waterfall row into the
// raw span id the detail endpoint expects. The wrapper id is built
// in transformCapturedToSpanData with the same `step-${step}-${node}-${safeNs}`
// template (safeNs = ns.replace(/[^a-z0-9]/gi, "")); the repRaw
// selection mirrors the same filter (node + step + ns + run_id) and
// picks the earliest span — matching the panel's prior rawById logic.
export function buildStepIdToRawSpanId(captured: CapturedSpan[]): Record<string, string> {
  const stepMap = new Map<string, { step: number; node: string; ns: string; run_id: string }>();
  for (const s of captured) {
    const node = s.meta?.langgraph_node;
    const step = s.meta?.langgraph_step;
    const ns =
      typeof s.meta?.langgraph_checkpoint_ns === "string" ? s.meta.langgraph_checkpoint_ns : "";
    const runId = typeof s.meta?.run_id === "string" ? s.meta.run_id : "";
    if (typeof node !== "string" || typeof step !== "number" || !runId) continue;
    const key = `${runId}::${ns}::${step}::${node}`;
    if (!stepMap.has(key)) stepMap.set(key, { step, node, ns, run_id: runId });
  }
  const out: Record<string, string> = {};
  for (const step of stepMap.values()) {
    const safeNs = step.ns.replace(/[^a-z0-9]/gi, "");
    const wrapperId = `step-${step.step}-${step.node}-${safeNs}`;
    const repRaw = [...captured]
      .filter(
        (s) =>
          s.meta?.langgraph_node === step.node &&
          s.meta?.langgraph_step === step.step &&
          (typeof s.meta?.langgraph_checkpoint_ns === "string"
            ? s.meta.langgraph_checkpoint_ns
            : "") === step.ns &&
          s.meta?.run_id === step.run_id,
      )
      .sort((a, b) => a.started_at - b.started_at)[0];
    if (repRaw) out[wrapperId] = repRaw.span_id;
  }
  return out;
}

// ponytail: a step's ns has at least one "|name:uuid" tail for every
// subgraph level it's nested inside. We pass all candidate ns in once and
// ask "is any of them a strict descendant of this step's ns?" — that's
// what makes a step a wrapper.
function collectWrapperCandidates(captured: CapturedSpan[]): { ns: string }[] {
  const stepMap = new Map<string, { ns: string }>();
  for (const s of captured) {
    const node = s.meta?.langgraph_node;
    const step = s.meta?.langgraph_step;
    const ns = s.meta?.langgraph_checkpoint_ns;
    if (typeof node !== "string" || typeof step !== "number" || typeof ns !== "string") continue;
    const key = `${ns}::${step}::${node}`;
    if (!stepMap.has(key)) stepMap.set(key, { ns });
  }
  return [...stepMap.values()];
}

function stepHasInner(step: Step, candidates: { ns: string }[]): boolean {
  const prefix = `${step.ns}|`;
  return candidates.some((c) => c.ns.startsWith(prefix));
}

// ponytail: hard ceiling on chain depth. SpanResource.calculateDepth is
// recursive and a single misplaced parent pointer can crash the thread.
// Walking the assembled `out` list one final time bumps any cycle back
// to `root` so the panel never loops.
const MAX_PARENT_DEPTH = 6;
function clampCycles(spans: SpanData[]): SpanData[] {
  const byId = new Map<string, SpanData>(spans.map((s) => [s.id, s]));
  for (const s of spans) {
    const seen = new Set<string>([s.id]);
    let cursor = s.parentSpanId;
    let depth = 0;
    while (cursor && !seen.has(cursor) && depth < MAX_PARENT_DEPTH) {
      seen.add(cursor);
      depth++;
      cursor = byId.get(cursor)?.parentSpanId ?? null;
    }
    if (cursor && seen.has(cursor)) {
      s.parentSpanId = "root";
    }
  }
  return spans;
}
