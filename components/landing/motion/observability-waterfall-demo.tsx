"use client";

// ponytail: abstract span waterfall. Same chrome as the live
// observability panel — sticky label column on the left, colored
// bars on the right — but the labels are span TYPES (node / llm /
// tool / chain) rather than real function names, so the demo
// reads as a shape, not a debug log. Bar colors mirror
// `TYPE_COLORS` from components/observability/panel.tsx; the
// inline icons mirror `TYPE_ICONS` from the same file so the
// labels read like the production panel at a glance. A vertical
// separator punches a hard line between "what's running" and
// "when it ran", matching the panel's gutter.

import { m, useInView, useReducedMotion } from "motion/react";
import { BoxIcon, BrainIcon, LinkIcon, WrenchIcon } from "lucide-react";
import type { ComponentType } from "react";
import { useRef } from "react";

import { cn } from "@/lib/utils";

const TYPE_COLORS: Record<string, string> = {
  node: "bg-amber-500",
  llm: "bg-violet-500",
  tool: "bg-emerald-500",
  chain: "bg-slate-500",
};

const TYPE_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  node: BoxIcon,
  llm: BrainIcon,
  tool: WrenchIcon,
  chain: LinkIcon,
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
// layout (root chain wrapping two sub-trees of node → llm/tool)
// is the story, not the labels. Chain sits at depth 0 and
// stretches full-width so it visibly contains every child.
const SPANS: SpanRow[] = [
  { label: "chain", type: "chain", start: 2, width: 96, depth: 0, delay: 0 },
  { label: "node", type: "node", start: 4, width: 42, depth: 1, delay: 0.08 },
  { label: "llm", type: "llm", start: 7, width: 18, depth: 2, delay: 0.16 },
  { label: "tool", type: "tool", start: 28, width: 14, depth: 2, delay: 0.24 },
  { label: "node", type: "node", start: 50, width: 42, depth: 1, delay: 0.32 },
  { label: "llm", type: "llm", start: 53, width: 26, depth: 2, delay: 0.4 },
  { label: "tool", type: "tool", start: 82, width: 8, depth: 2, delay: 0.48 },
];

const LABEL_WIDTH = 124;

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
          {SPANS.map((span, i) => {
            const Icon = TYPE_ICONS[span.type];
            // ponytail: include the row index — `(label, depth)`
            // is not unique (root `node` appears twice, root
            // `llm` twice), which crashes React's reconciliation
            // and surfaces a console error.
            return (
              <div
                key={`${span.label}-${span.depth}-${i}`}
                className="flex items-stretch gap-0 px-3 py-1.5"
              >
                <div
                  className={cn(
                    "border-border/60 text-foreground/80 flex shrink-0 items-center gap-1.5 border-r truncate font-mono text-[11px]",
                  )}
                  // ponytail: cell width is fixed across rows so
                  // the divider (right border) lines up. Depth
                  // shows as inner padding only — otherwise
                  // child rows slide left and the vertical
                  // separator slants.
                  style={{
                    width: LABEL_WIDTH - 12,
                    paddingLeft: span.depth * 12,
                  }}
                >
                  {Icon && (
                    <Icon
                      className={cn(
                        "size-3 shrink-0",
                        span.type === "node" && "text-amber-500",
                        span.type === "llm" && "text-violet-500",
                        span.type === "tool" && "text-emerald-500",
                        span.type === "chain" && "text-slate-500",
                      )}
                      aria-hidden
                    />
                  )}
                  {span.label}
                </div>
                <div className="relative h-3 flex-1 pl-3">
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
            );
          })}
        </div>
      </div>

      {/* ponytail: mirror the bar row's label+gap structure so
          the "0ms" tick lines up with `left: 0%` of the bars. A
          plain `px-3` row would put the watermark at the panel's
          left edge, but the first bar starts after the label
          column — they'd be off by LABEL_WIDTH. */}
      <div className="text-muted-foreground flex items-stretch gap-0 px-3 text-[10px] font-mono">
        <div className="border-border/60 shrink-0 border-r" style={{ width: LABEL_WIDTH - 12 }} />
        <div className="relative flex-1 pl-3">
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
