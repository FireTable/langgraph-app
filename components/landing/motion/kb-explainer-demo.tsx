"use client";

// ponytail: KB explainer — two stacked panels in one card.
//   Top: PDF → OCR → chunk → embed pipeline. Plays once on scroll
//        into view (stages light up + arrows draw in sequence).
//   Bottom: entity graph traversal. Same scroll trigger; plays
//        after the pipeline settles.
//
// Why both: the pipeline shows the WRITE path (how a PDF becomes a
// searchable index); the graph shows the READ path (how a query
// traverses entities + relationships). Together they cover the
// round trip — that's the story the How-it-works row tells.

import { m, useInView, useReducedMotion } from "motion/react";
import { Fragment, useEffect, useRef, useState } from "react";
import {
  ArrowRightIcon,
  BlocksIcon,
  FileTextIcon,
  LayersIcon,
  ScanTextIcon,
  SearchIcon,
  SparklesIcon,
  WorkflowIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

type Stage = {
  id: string;
  label: string;
  icon: typeof FileTextIcon;
  // ponytail: literal Tailwind colors so JIT picks them up — dynamic
  // text-${color}-500 / bg-${color}-500 would silently no-op.
  lit: string;
};

const STAGES: Stage[] = [
  {
    id: "pdf",
    label: "PDF",
    icon: FileTextIcon,
    lit: "text-rose-500 border-rose-500/40 bg-rose-500/10",
  },
  {
    id: "ocr",
    label: "OCR",
    icon: ScanTextIcon,
    lit: "text-amber-500 border-amber-500/40 bg-amber-500/10",
  },
  {
    id: "chunk",
    label: "Chunk",
    icon: LayersIcon,
    lit: "text-emerald-500 border-emerald-500/40 bg-emerald-500/10",
  },
  {
    id: "embed",
    label: "Embed",
    icon: BlocksIcon,
    lit: "text-sky-500 border-sky-500/40 bg-sky-500/10",
  },
  {
    id: "entity",
    label: "Entity",
    icon: WorkflowIcon,
    lit: "text-violet-500 border-violet-500/40 bg-violet-500/10",
  },
];

type GraphNode = {
  id: string;
  label: string;
  x: number;
  y: number;
  lit: string;
  type: "query" | "person" | "tech" | "concept" | "project";
  z?: number; // 0..1 for perspective scaling (front-side larger)
};

type GraphEdge = [string, string];

// ponytail: spherical layout — Fibonacci-sphere distribution around
// the center reads as a 3D ball at a glance. ~20 nodes is dense
// enough to feel like a "real" graph without crowding a 320px-wide
// demo card. Z coordinate drives the SVG radius so back-side nodes
// sit smaller (perspective).
//
// Node colors cycle through a fixed palette — palette is the
// visual story, individual labels matter less. Query node is the
// primary-colored "?" in the middle; everything else is an entity.
// ponytail: solid fill only (no stroke) — the previous
// `fill-X stroke-X` pair rendered the line through the circle's
// outline. Without a stroke the node reads as a solid dot and the
// edge ends cleanly behind it.
const PALETTE = [
  "fill-rose-500",
  "fill-amber-500",
  "fill-emerald-500",
  "fill-sky-500",
  "fill-violet-500",
  "fill-orange-500",
  "fill-fuchsia-500",
  "fill-teal-500",
];

// ponytail: deterministic pseudo-random edges so the graph looks
// organic but reproducible. Each new node gets 2-3 random edges to
// earlier nodes — keeps mean degree low so the layout stays legible.
function buildGraph(nodeCount: number) {
  const nodes: GraphNode[] = [];
  // Query node centered
  nodes.push({
    id: "q",
    label: "?",
    x: 100,
    y: 100,
    lit: "fill-primary",
    type: "query",
  });
  const cx = 100;
  const cy = 100;
  const sphereR = 75;
  // Fibonacci sphere — gives even angular distribution
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < nodeCount - 1; i++) {
    const idx = i + 1;
    const yNorm = 1 - (idx / (nodeCount - 1)) * 2; // -1..1
    const radiusAtY = Math.sqrt(1 - yNorm * yNorm);
    const theta = goldenAngle * idx;
    const x3d = Math.cos(theta) * radiusAtY;
    const z3d = Math.sin(theta) * radiusAtY; // -1..1
    // Map to 2D + scale Z to perspective radius
    nodes.push({
      id: `n${idx}`,
      label: "",
      x: cx + x3d * sphereR,
      y: cy + yNorm * sphereR,
      lit: PALETTE[(idx - 1) % PALETTE.length] ?? PALETTE[0]!,
      type: "concept",
      // z normalized 0..1 (front-side larger)
      z: (z3d + 1) / 2,
    });
  }
  // Edges: each non-query node connects to its 2 nearest neighbours
  // (by Euclidean distance) — produces an organic-looking web. The
  // edge set is canonical (i,j) regardless of which node added it
  // first, so dedup is a Set keyed on sorted-pair ids.
  const edgeKeys = new Set<string>();
  const edges: GraphEdge[] = [];
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i]!;
    const dists: Array<{ id: string; d: number }> = [];
    for (let j = 1; j < nodes.length; j++) {
      if (i === j) continue;
      const b = nodes[j]!;
      dists.push({ id: b.id, d: Math.hypot(a.x - b.x, a.y - b.y) });
    }
    dists.sort((x, y) => x.d - y.d);
    for (const n of dists.slice(0, 2)) {
      const key = [a.id, n.id].sort().join("|");
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push([a.id, n.id]);
    }
  }
  // Hook the query node to the 3 closest entities so the traversal
  // visual reads as "query hits the graph"
  const queryDists = nodes
    .slice(1)
    .map((n) => ({ id: n.id, d: Math.hypot(n.x - cx, n.y - cy) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3);
  for (const q of queryDists) {
    edges.push(["q", q.id]);
  }
  return { nodes, edges };
}

const { nodes: NODES, edges: EDGES } = buildGraph(20);

const NODE_R = 5;

// ponytail: 2-hop BFS from the query node to find the pulse set.
// Pre-computed (NODES is static) so the demo runs without a real
// graph search — keeps the file readable and unit-testable.
const PULSE_IDS = new Set<string>(["q"]);
const hop1 = new Set<string>();
const hop2 = new Set<string>();
for (const [from, to] of EDGES) {
  if (from === "q") hop1.add(to);
}
for (const [from, to] of EDGES) {
  if (hop1.has(from)) hop2.add(to);
}
for (const id of hop1) PULSE_IDS.add(id);
for (const id of hop2) PULSE_IDS.add(id);

// ponytail: timing — pipeline first, graph second. The pipeline is
// the "how a doc gets in" story; the graph is the "how a query
// finds it" story. Sequencing keeps the eye on the ingest path
// before the read path lights up.
const STAGE_DURATION = 200;
const PIPELINE_QUERY_DELAY = STAGES.length * STAGE_DURATION + 200;
const PIPELINE_RETRIEVE_DELAY = PIPELINE_QUERY_DELAY + 300;
const GRAPH_NODE_DELAY = PIPELINE_RETRIEVE_DELAY + 400;
const GRAPH_PULSE_DELAY = GRAPH_NODE_DELAY + NODES.length * 100 + 200;

export const KbExplainerDemo = () => {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.3 });
  const [step, setStep] = useState(reduced ? STAGES.length + NODES.length + 4 : 0);

  useEffect(() => {
    if (reduced) return;
    if (!inView) {
      setStep(0);
      return;
    }
    let cancelled = false;
    const timers: number[] = [];
    // Pipeline stages
    for (let i = 1; i <= STAGES.length; i++) {
      timers.push(
        window.setTimeout(() => !cancelled && setStep((s) => Math.max(s, i)), STAGE_DURATION * i),
      );
    }
    // Query card
    timers.push(
      window.setTimeout(
        () => !cancelled && setStep((s) => Math.max(s, STAGES.length + 1)),
        PIPELINE_QUERY_DELAY,
      ),
    );
    // Retrieved chunk card
    timers.push(
      window.setTimeout(
        () => !cancelled && setStep((s) => Math.max(s, STAGES.length + 2)),
        PIPELINE_RETRIEVE_DELAY,
      ),
    );
    // Graph nodes
    for (let i = 1; i <= NODES.length; i++) {
      timers.push(
        window.setTimeout(
          () => !cancelled && setStep((s) => Math.max(s, STAGES.length + 2 + i)),
          GRAPH_NODE_DELAY + 100 * i,
        ),
      );
    }
    // Graph pulse
    timers.push(
      window.setTimeout(
        () => !cancelled && setStep((s) => Math.max(s, STAGES.length + 2 + NODES.length + 1)),
        GRAPH_PULSE_DELAY,
      ),
    );
    return () => {
      cancelled = true;
      timers.forEach((id) => window.clearTimeout(id));
    };
  }, [inView, reduced]);

  const pipelineLit = Math.min(step, STAGES.length);
  const queryVisible = step > STAGES.length;
  const retrieveVisible = step > STAGES.length + 1;
  const graphLit = Math.max(0, Math.min(step - STAGES.length - 2, NODES.length));
  const graphPulse = step > STAGES.length + 2 + NODES.length;

  return (
    <div ref={ref} className="bg-background flex w-full max-w-lg flex-col gap-4 rounded-xl p-5">
      {/* === Pipeline row === */}
      <div className="flex flex-col gap-3">
        <div className="text-muted-foreground flex flex-col gap-0.5 text-[11px] font-medium tracking-wide uppercase">
          <span>KB ingest pipeline</span>
          <span className="text-muted-foreground/70 text-[10px] font-normal normal-case tracking-normal">
            per document
          </span>
        </div>

        <div className="relative">
          <div className="flex flex-wrap items-center justify-center md:justify-between flex-wrap gap-x-1.5 gap-y-2">
            {STAGES.map((stage, i) => (
              <Fragment key={stage.id}>
                <StageBox stage={stage} lit={i < pipelineLit} />
                {i < STAGES.length - 1 && (
                  <m.div
                    initial={{ opacity: 0, scale: 0.6 }}
                    animate={
                      pipelineLit > i + 1 ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.6 }
                    }
                    transition={{ duration: 0.25, ease: "easeOut" }}
                    aria-hidden
                  >
                    <ArrowRightIcon
                      className={cn(
                        "size-4 shrink-0 transition-colors",
                        "text-muted-foreground/40",
                      )}
                    />
                  </m.div>
                )}
              </Fragment>
            ))}
          </div>
        </div>

        {/* Retrieval layer — only after the pipeline completes. */}
        <div className="border-border/60 flex min-h-[80px] flex-col gap-2 border-t pt-3">
          <m.div
            initial={{ opacity: 0, y: 4 }}
            animate={queryVisible ? { opacity: 1, y: 0 } : { opacity: 0, y: 4 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="border-border/60 bg-muted/30 flex items-center gap-2 rounded-lg border px-3 py-2"
          >
            <SearchIcon className="text-muted-foreground size-3.5" aria-hidden />
            <span className="text-foreground/90 truncate text-xs">
              what does the doc say about <span className="font-medium">@kb-doc</span>?
            </span>
          </m.div>
          <m.div
            initial={{ opacity: 0, y: 6 }}
            animate={retrieveVisible ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 }}
            transition={{ duration: 0.35, ease: "easeOut" }}
            className="border-primary/30 bg-primary/5 flex items-start gap-2 rounded-lg border px-3 py-2"
          >
            <SparklesIcon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden />
            <p className="text-foreground/90 text-xs leading-snug">
              <span className="text-muted-foreground">[chunk 7 · vector + entity hit · 0.94]</span>{" "}
              The BM25 leg finds the exact term; the entity leg ties it to the canonical name.
            </p>
          </m.div>
        </div>
      </div>

      {/* === Graph row === */}
      <div className="border-border/60 flex flex-col gap-3 border-t pt-3">
        <div className="text-muted-foreground flex flex-col gap-0.5 text-[11px] font-medium tracking-wide uppercase">
          <span>Entity graph</span>
          <span className="text-muted-foreground/70 text-[10px] font-normal normal-case tracking-normal">
            graph traversal
          </span>
        </div>

        <div className="border-border/40 bg-muted/20 relative overflow-hidden rounded-md border p-2">
          <svg viewBox="0 0 200 200" className="h-52 w-full">
            {/* ponytail: defs come first so the arrow marker is
                available to every edge below. markerUnits="userSpaceOnUse"
                keeps the arrowhead size constant regardless of the
                line's stroke width — otherwise the head scales with
                the edge and pulses look uneven. */}
            <defs>
              <marker
                id="kb-graph-arrow"
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
                markerUnits="userSpaceOnUse"
              >
                <path d="M 0 0 L 8 4 L 0 8 z" className="fill-muted-foreground/50" />
              </marker>
              <marker
                id="kb-graph-arrow-pulse"
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
                markerUnits="userSpaceOnUse"
              >
                <path d="M 0 0 L 8 4 L 0 8 z" className="fill-primary" />
              </marker>
            </defs>
            {/* ponytail: edges render FIRST so nodes sit on top — the
                "lines drawn over circles" bug is just SVG paint order
                (later elements sit above earlier ones). */}
            {EDGES.map(([fromId, toId], i) => {
              const from = NODES.find((n) => n.id === fromId)!;
              const to = NODES.find((n) => n.id === toId)!;
              const fromIdx = NODES.findIndex((n) => n.id === fromId);
              const toIdx = NODES.findIndex((n) => n.id === toId);
              const lit = graphLit > Math.max(fromIdx, toIdx);
              const isPulseEdge = graphPulse && PULSE_IDS.has(fromId) && PULSE_IDS.has(toId);
              return (
                <m.line
                  key={`${fromId}-${toId}-${i}`}
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  stroke="currentColor"
                  strokeWidth={isPulseEdge ? 1.4 : 1}
                  strokeLinecap="round"
                  // ponytail: marker-end is the SVG-native way to add
                  // an arrowhead. The line's currentColor picks up the
                  // muted-foreground (grey) for non-pulse, primary for
                  // pulse — same scheme as before, just with arrows.
                  markerEnd={isPulseEdge ? "url(#kb-graph-arrow-pulse)" : "url(#kb-graph-arrow)"}
                  className={cn("transition-colors duration-300", "text-muted-foreground/50")}
                  initial={{ pathLength: 0, opacity: 0 }}
                  animate={
                    lit
                      ? { pathLength: 1, opacity: isPulseEdge ? 1 : 0.6 }
                      : { pathLength: 0, opacity: 0 }
                  }
                  transition={{ duration: 0.3, ease: "easeOut", delay: i * 0.05 }}
                />
              );
            })}
            {NODES.map((node, i) => {
              const lit = i < graphLit;
              const isPulse = graphPulse && PULSE_IDS.has(node.id);
              // ponytail: z drives the SVG radius — front-side nodes
              // (z=1) render larger, back-side (z=0) smaller. The
              // 0.85..1.3 range keeps the smallest back-side node
              // wide enough to fully cover the line behind it; the
              // earlier 0.6 floor left a visible edge bleed. Query
              // node sits at the centre so it gets the largest
              // radius. Opacity stays 1.0 throughout — the
              // perspective comes from size only, and a
              // semi-transparent node lets the line behind show
              // through, which reads as a bug.
              const z = node.z ?? 0.5;
              const rScale = 0.85 + z * 0.45;
              const baseR = node.type === "query" ? NODE_R * 1.6 : NODE_R;
              const r = isPulse ? baseR * rScale * 1.2 : baseR * rScale;
              return (
                <m.g
                  key={node.id}
                  initial={{ scale: 0, opacity: 0 }}
                  animate={lit ? { scale: 1, opacity: 1 } : { scale: 0, opacity: 0 }}
                  transition={{ duration: 0.25, ease: "easeOut" }}
                >
                  <m.circle
                    cx={node.x}
                    cy={node.y}
                    r={r}
                    className={cn("transition-colors duration-300", lit ? node.lit : "fill-muted")}
                    animate={isPulse ? { scale: [1, 1.15, 1] } : { scale: 1 }}
                    transition={
                      isPulse
                        ? { duration: 1.4, repeat: Infinity, ease: "easeInOut" }
                        : { duration: 0.2 }
                    }
                    style={{ transformOrigin: `${node.x}px ${node.y}px` }}
                  />
                  {/* ponytail: only the query node gets a label — 20
                      nodes with text would be illegible at this
                      scale. The query reads as the "?" so the user
                      can identify the centre of the traversal. */}
                  {node.type === "query" && (
                    <text
                      x={node.x}
                      y={node.y + 3}
                      textAnchor="middle"
                      className="fill-primary-foreground font-mono text-[8px] font-semibold"
                    >
                      {node.label}
                    </text>
                  )}
                </m.g>
              );
            })}
          </svg>
        </div>

        <div className="text-muted-foreground flex items-start gap-2 text-[11px] leading-snug">
          <SparklesIcon className="text-muted-foreground mt-0.5 size-3 shrink-0" aria-hidden />
          <span>
            Query <span className="text-foreground font-medium">?</span> lights up its 2-hop
            neighborhood. The graph leg scores every entity it touches alongside BM25 + vector.
          </span>
        </div>
      </div>
    </div>
  );
};

const StageBox = ({ stage, lit }: { stage: Stage; lit: boolean }) => {
  const Icon = stage.icon;
  return (
    <m.div
      initial={{ opacity: 0, scale: 0.92 }}
      animate={lit ? { opacity: 1, scale: 1 } : { opacity: 0.5, scale: 0.96 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className={cn(
        "border-border/40 bg-muted/30 text-muted-foreground flex size-10 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg border",
        lit && stage.lit,
      )}
      aria-label={stage.label}
    >
      <Icon className="size-4" aria-hidden />
      <span className="text-[8px] font-medium tracking-wide uppercase opacity-80">
        {stage.label}
      </span>
    </m.div>
  );
};
