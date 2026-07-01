// ponytail: transforms CapturedSpan[] (callback handler output) into the
// SpanData[] shape that @assistant-ui/react-o11y consumes, plus a list of
// "wrapper" node names (subgraphs) for the chip label.
//
// Parent chain comes from the backend (CapturingHandler in
// backend/observability/callback-collector.ts), which derives it from
// langgraph_checkpoint_ns. The frontend does not recompute parents.
import type { SpanData } from "@assistant-ui/react-o11y";
import type { CapturedSpan } from "@/backend/observability/callback-collector";

type Step = {
  step: number;
  node: string;
  ns: string;
  started: number;
  ended: number | null;
  leaves: CapturedSpan[];
};

function stepKey(s: Step): string {
  return `${s.ns}::${s.step}::${s.node}`;
}

const LANGSMITH_NOISE = new Set(["RunnableSequence", "RunnableLambda", "parser"]);

export function transformCapturedToSpanData(captured: CapturedSpan[]): SpanData[] {
  const stepMap = new Map<string, Step>();
  for (const s of captured) {
    const node = s.meta?.langgraph_node;
    const step = s.meta?.langgraph_step;
    if (typeof node !== "string" || typeof step !== "number") continue;
    const ns =
      typeof s.meta?.langgraph_checkpoint_ns === "string" ? s.meta.langgraph_checkpoint_ns : "";
    const key = stepKey({ step, node, ns, started: 0, ended: null, leaves: [] });
    const bucket = stepMap.get(key) ?? {
      step,
      node,
      ns,
      started: s.started_at,
      ended: s.ended_at,
      leaves: [],
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

  const rootStart = steps.reduce((m, s) => Math.min(m, s.started), Infinity);
  const rootEnd = steps.reduce((m, s) => Math.max(m, s.ended ?? 0), 0);
  const rootLatency = rootEnd > rootStart ? rootEnd - rootStart : null;

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
    if (typeof node !== "string" || typeof step !== "number") continue;
    const k = stepKey({ step, node, ns, started: 0, ended: null, leaves: [] });
    const bucket = stepMap.get(k);
    if (bucket) stepBySpanId.set(s.span_id, bucket);
  }

  const root: SpanData = {
    id: "root",
    parentSpanId: null,
    name: "graph.invoke",
    type: "chain",
    status: "completed",
    startedAt: rootStart,
    endedAt: rootEnd || null,
    latencyMs: rootLatency,
  };

  const stepIdByStepAndName = new Map<string, string>();
  for (const step of steps) {
    const safeNs = step.ns.replace(/[^a-z0-9]/gi, "");
    stepIdByStepAndName.set(stepKey(step), `step-${step.step}-${step.node}-${safeNs}`);
  }

  const wrapperCandidates = collectWrapperCandidates(captured);

  const out: SpanData[] = [root];
  // ponytail: SpanResource walks spans by parent_span_id. If two steps
  // share a parent_step key OR a step's ns is its own ancestor, the depth
  // walk recurses forever and blows the stack. Anchor each step's parent
  // at the nearest strictly-outer step (a shorter ns), or root. We also
  // bail at MAX_PARENT_DEPTH in case the ns game isn't enough.
  const parentIdFor = (s: Step): string => {
    for (const candidate of steps) {
      if (candidate === s) continue;
      if (candidate.step >= s.step) continue;
      if (s.ns === candidate.ns) continue;
      if (s.ns.startsWith(`${candidate.ns}|`)) return stepIdByStepAndName.get(stepKey(candidate))!;
    }
    return "root";
  };
  for (const step of steps) {
    const id = stepIdByStepAndName.get(stepKey(step))!;
    const repRaw = [...captured]
      .filter((s) => {
        const n = s.meta?.langgraph_node;
        const st = s.meta?.langgraph_step;
        const sn =
          typeof s.meta?.langgraph_checkpoint_ns === "string" ? s.meta.langgraph_checkpoint_ns : "";
        return n === step.node && st === step.step && sn === step.ns;
      })
      .sort((a, b) => a.started_at - b.started_at)[0];
    let parentId: string = "root";
    if (repRaw?.parent_span_id) {
      const parentStep = stepBySpanId.get(repRaw.parent_span_id);
      if (parentStep && parentStep !== step) {
        parentId = stepIdByStepAndName.get(stepKey(parentStep)) ?? "root";
      } else {
        parentId = parentIdFor(step);
      }
    } else {
      parentId = parentIdFor(step);
    }
    const type = stepHasInner(step, wrapperCandidates) ? "chain" : "node";
    out.push({
      id,
      parentSpanId: parentId,
      name: step.node,
      type,
      status: step.ended ? "completed" : "running",
      startedAt: step.started,
      endedAt: step.ended,
      latencyMs: step.ended ? step.ended - step.started : null,
    });
    for (const leaf of step.leaves) {
      out.push({
        id: leaf.span_id,
        parentSpanId: id,
        name: leaf.name,
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
      });
    }
  }

  return clampCycles(out);
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
