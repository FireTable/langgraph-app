// ponytail: transforms /tmp/captured-spans.json into the SpanData[] shape
// that @assistant-ui/react-o11y consumes, plus a list of "wrapper" node
// names (subgraphs) for the chip label.
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

export function toSpanData(captured: CapturedSpan[]): SpanData[] {
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
    if ((s.kind === "llm" || s.kind === "tool") && !LANGSMITH_NOISE.has(s.name)) {
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
  for (const step of steps) {
    const id = stepIdByStepAndName.get(stepKey(step))!;
    // ponytail: pick the representative raw span for parent resolution —
    // one whose ns matches THIS step's ns (so inner/outer __start__ don't
    // collide). Earliest start within the ns bucket = the chain wrapper.
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
      if (parentStep) parentId = stepIdByStepAndName.get(stepKey(parentStep)) ?? "root";
    }
    const type = stepHasInner(step, wrapperCandidates) ? "chain" : "node";
    out.push({
      id,
      parentSpanId: parentId,
      name: `${step.node} (step ${step.step})`,
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
        status: leaf.status,
        startedAt: leaf.started_at,
        endedAt: leaf.ended_at,
        latencyMs: leaf.ended_at ? leaf.ended_at - leaf.started_at : null,
      });
    }
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
