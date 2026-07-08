"use client";

// ponytail: multi-graph diagram. Two abstract StateGraphs side by
// side, no real node names — the user reads the SHAPE, not the
// source. Chat graph lights up node-by-node, then a dispatch
// edge draws to the background graph, which then lights up. The
// visual story is "chat hands off, background runs after".

import { m, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

// Layout is hard-coded; the diagrams are decorative, not data.
// ponytail: each node carries literal Tailwind class strings (not
// color names) — dynamic `text-${color}-500` won't be picked up
// by the JIT scanner, so the strings live as full literals here.
const CHAT_NODES = [
  { id: "c0", x: 24, y: 22, lit: "fill-violet-500 stroke-violet-500", edge: "text-violet-500" },
  { id: "c1", x: 88, y: 60, lit: "fill-rose-500 stroke-rose-500", edge: "text-rose-500" },
  { id: "c2", x: 24, y: 98, lit: "fill-amber-500 stroke-amber-500", edge: "text-amber-500" },
  {
    id: "c3",
    x: 152,
    y: 124,
    lit: "fill-emerald-500 stroke-emerald-500",
    edge: "text-emerald-500",
  },
  { id: "c4", x: 88, y: 162, lit: "fill-sky-500 stroke-sky-500", edge: "text-sky-500" },
] as const;

const CHAT_EDGES: Array<[string, string]> = [
  ["c0", "c1"],
  ["c0", "c2"],
  ["c1", "c3"],
  ["c2", "c3"],
  ["c3", "c4"],
];

const BG_NODES = [
  { id: "b0", x: 20, y: 95, lit: "fill-fuchsia-500 stroke-fuchsia-500", edge: "text-fuchsia-500" },
  { id: "b1", x: 75, y: 60, lit: "fill-orange-500 stroke-orange-500", edge: "text-orange-500" },
  { id: "b2", x: 130, y: 100, lit: "fill-teal-500 stroke-teal-500", edge: "text-teal-500" },
  { id: "b3", x: 180, y: 130, lit: "fill-blue-500 stroke-blue-500", edge: "text-blue-500" },
] as const;

// ponytail: linear chain (touchLastMessage → summarize → …), no
// converging edges. The previous diamond was a closed loop and
// read as a cycle rather than a pipeline.
const BG_EDGES: Array<[string, string]> = [
  ["b0", "b1"],
  ["b1", "b2"],
  ["b2", "b3"],
];

const NODE_R = 7;

function findNode<T extends { id: string }>(list: readonly T[], id: string): T {
  return list.find((n) => n.id === id)!;
}

export const BackgroundSplitDemo = () => {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.3 });
  const [step, setStep] = useState(reduced ? CHAT_NODES.length + BG_NODES.length : 0);

  useEffect(() => {
    if (reduced) return;
    if (!inView) {
      setStep(0);
      return;
    }
    // ponytail: chained setTimeout drives the reveal — chat graph
    // lights up node-by-node, then the dispatch edge draws, then
    // the background graph lights up. Same chain pattern as the
    // streaming-tokens demo so the "play once and stop" beat is
    // consistent across the section.
    const TIMINGS: Array<{ delay: number }> = [
      ...CHAT_NODES.map((_, i) => ({ delay: 280 * (i + 1) })),
      { delay: 280 * (CHAT_NODES.length + 1) },
      ...BG_NODES.map((_, i) => ({
        delay: 280 * (CHAT_NODES.length + 2 + i),
      })),
    ];
    const timers: number[] = [];
    TIMINGS.forEach(({ delay }) => {
      const id = window.setTimeout(() => {
        setStep((s) => s + 1);
      }, delay);
      timers.push(id);
    });
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [inView, reduced]);

  const litChat = Math.min(step, CHAT_NODES.length);
  const dispatchLit = step > CHAT_NODES.length;
  const litBg = Math.max(0, Math.min(step - CHAT_NODES.length - 1, BG_NODES.length));

  return (
    <div ref={ref} className="bg-background flex w-full max-w-lg flex-col gap-3 rounded-xl p-5">
      <div className="text-muted-foreground flex items-center justify-between text-[11px] font-medium tracking-wide uppercase">
        <span>Agent Graph</span>
        <span>Background Agent Graph</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <GraphPanel nodes={CHAT_NODES} edges={CHAT_EDGES} litNodes={litChat} />
        <GraphPanel nodes={BG_NODES} edges={BG_EDGES} litNodes={litBg} />
      </div>
      <div className="text-muted-foreground flex items-center gap-2 text-[10px] font-mono">
        <span
          className={cn(
            "inline-block size-1.5 rounded-full transition-colors",
            dispatchLit ? "bg-emerald-500" : "bg-border",
          )}
        />
        <span>runs.create dispatch {dispatchLit ? "✓" : "…"}</span>
      </div>
    </div>
  );
};

type NodeSpec = { id: string; x: number; y: number; lit: string; edge: string };

type GraphPanelProps = {
  nodes: readonly NodeSpec[];
  edges: Array<[string, string]>;
  litNodes: number;
};

const GraphPanel = ({ nodes, edges, litNodes }: GraphPanelProps) => (
  <div className="border-border/60 bg-muted/30 flex flex-col gap-2 rounded-lg border p-2">
    <svg viewBox="0 0 200 190" className="h-32 w-full">
      {edges.map(([fromId, toId]) => {
        const from = findNode(nodes, fromId);
        const to = findNode(nodes, toId);
        // ponytail: light up when the *target* node is lit, not
        // by edge index. The previous `i + 1` made the last edge
        // (which targets the last node) need litNodes > n+1, an
        // impossible condition — its node lit but the edge to it
        // never did, leaving a stranded "extra" dot.
        const toIdx = nodes.findIndex((n) => n.id === toId);
        const lit = toIdx >= 0 && litNodes > toIdx;
        return (
          <m.line
            key={`${fromId}-${toId}`}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke="currentColor"
            strokeWidth={1.2}
            strokeLinecap="round"
            // ponytail: color the edge to match its target so the
            // lit-up "thread" is a chain of distinct colors, not
            // a uniform grey.
            className={cn("transition-colors duration-300", lit ? to.edge : "text-border")}
            initial={{ pathLength: 0 }}
            animate={{ pathLength: lit ? 1 : 0 }}
          />
        );
      })}
      {nodes.map((node, i) => {
        const lit = i < litNodes;
        return (
          <m.circle
            key={node.id}
            cx={node.x}
            cy={node.y}
            r={NODE_R}
            initial={{ scale: 0, opacity: 0 }}
            animate={lit ? { scale: 1, opacity: 1 } : { scale: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className={cn(
              "transition-colors duration-300",
              lit ? node.lit : "fill-muted stroke-border",
            )}
            strokeWidth={1.5}
          />
        );
      })}
    </svg>
  </div>
);
