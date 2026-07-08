"use client";

// ponytail: abstract span waterfall. Same chrome as the live
// observability panel — sticky label column on the left, colored
// bars on the right — but the labels are span TYPES (graph / llm
// / tool / chain) rather than real function names, so the demo
// reads as a shape, not a debug log. Bar colors mirror
// `TYPE_COLORS` from components/observability/panel.tsx.

import { m, useInView, useReducedMotion } from "motion/react";
import { useRef } from "react";

import { cn } from "@/lib/utils";

const TYPE_COLORS: Record<string, string> = {
  graph: "bg-amber-500",
  llm: "bg-violet-500",
  tool: "bg-emerald-500",
  chain: "bg-slate-500",
};

type SpanRow = {
  label: string;
  type: keyof typeof TYPE_COLORS;
  start: number; // percent
  width: number; // percent
  depth: number;
  delay: number;
};

// Abstract shapes — types only, no specific function names. The
// layout (root + nested children) is the story, not the labels.
const SPANS: SpanRow[] = [
  { label: "graph", type: "graph", start: 0, width: 20, depth: 0, delay: 0 },
  { label: "llm", type: "llm", start: 4, width: 12, depth: 1, delay: 0.08 },
  { label: "graph", type: "graph", start: 24, width: 64, depth: 0, delay: 0.16 },
  { label: "llm", type: "llm", start: 30, width: 50, depth: 1, delay: 0.24 },
  { label: "tool", type: "tool", start: 38, width: 22, depth: 2, delay: 0.32 },
  { label: "chain", type: "chain", start: 82, width: 14, depth: 0, delay: 0.4 },
];

const LABEL_WIDTH = 116;

export const ObservabilityWaterfallDemo = () => {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.3 });
  const visible = reduced || inView;

  return (
    <div ref={ref} className="bg-background flex w-full max-w-lg flex-col gap-2 rounded-xl p-4">
      <div className="text-muted-foreground flex items-center justify-between text-[11px] font-medium tracking-wide uppercase">
        <span>waterfall</span>
        <span>per turn</span>
      </div>

      <div className="border-border/40 overflow-hidden rounded-md border">
        <div className="divide-border/40 divide-y">
          {SPANS.map((span, i) => (
            // ponytail: include the row index — `(label, depth)`
            // is not unique (root `graph` appears twice, root
            // `llm` twice), which crashes React's reconciliation
            // and surfaces a console error.
            <div
              key={`${span.label}-${span.depth}-${i}`}
              className="flex items-center gap-3 px-3 py-1.5"
            >
              <div
                className="text-foreground/80 shrink-0 truncate font-mono text-[11px]"
                style={{
                  width: LABEL_WIDTH - 12 - span.depth * 12,
                  paddingLeft: span.depth * 12,
                }}
              >
                {span.label}
              </div>
              <div className="relative h-3 flex-1">
                <m.div
                  initial={{ scaleX: 0, opacity: 0 }}
                  animate={visible ? { scaleX: 1, opacity: 1 } : { scaleX: 0, opacity: 0 }}
                  transition={{ duration: 0.4, ease: "easeOut", delay: span.delay }}
                  style={{
                    left: `${span.start}%`,
                    width: `${span.width}%`,
                    transformOrigin: "left center",
                  }}
                  className={cn("absolute top-0 h-full rounded-sm", TYPE_COLORS[span.type])}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ponytail: mirror the bar row's label+gap structure so
          the "0ms" tick lines up with `left: 0%` of the bars. A
          plain `px-3` row would put the watermark at the panel's
          left edge, but the first bar starts after the label
          column — they'd be off by LABEL_WIDTH. */}
      <div className="text-muted-foreground flex items-center gap-3 px-3 text-[10px] font-mono">
        <div className="shrink-0" style={{ width: LABEL_WIDTH - 12 }} />
        <div className="relative flex-1">
          <div className="flex justify-between">
            <span>0ms</span>
            <span>240ms</span>
            <span>480ms</span>
          </div>
        </div>
      </div>
    </div>
  );
};
