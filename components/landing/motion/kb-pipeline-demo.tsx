"use client";

// ponytail: KB ingest pipeline diagram — five stages mirroring
// `backend/agent/kb-agent.ts` (PDF → OCR → chunk → embed → entity).
// Plays once on scroll into view: each stage lights up in turn, the
// arrows between them draw, and the final stage reveals a sample
// search query that resolves to a chunk card. The visual story is
// "upload a PDF, ask a question, get a grounded answer" — same
// `once: true` contract as the streaming-tokens / memory-recall
// demos so the page reads as a sequence of play-once beats.

import { m, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { FileTextIcon, SearchIcon, SparklesIcon } from "lucide-react";

import { cn } from "@/lib/utils";

type Stage = {
  id: string;
  label: string;
  // ponytail: literal Tailwind colors so JIT picks them up — dynamic
  // text-${color}-500 / bg-${color}-500 would silently no-op.
  lit: string;
};

const STAGES: Stage[] = [
  { id: "pdf", label: "PDF", lit: "text-rose-500 border-rose-500/40 bg-rose-500/10" },
  { id: "ocr", label: "OCR", lit: "text-amber-500 border-amber-500/40 bg-amber-500/10" },
  { id: "chunk", label: "Chunk", lit: "text-emerald-500 border-emerald-500/40 bg-emerald-500/10" },
  { id: "embed", label: "Embed", lit: "text-sky-500 border-sky-500/40 bg-sky-500/10" },
  {
    id: "entity",
    label: "Entity",
    lit: "text-violet-500 border-violet-500/40 bg-violet-500/10",
  },
];

// ponytail: the demo's two layers — pipeline + retrieval — play in
// sequence. Pipeline stages light up first (0–1400ms), then the
// query box + retrieved chunk card appear (1600–2200ms). Splitting
// them keeps the visual rhythm honest: the ingest pipeline is the
// reason RAG works, but the user only sees retrieval at query time.

const STAGE_DURATION = 220;
const QUERY_DELAY = STAGES.length * STAGE_DURATION + 200;
const RETRIEVE_DELAY = QUERY_DELAY + 400;

export const KbPipelineDemo = () => {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.3 });
  const [step, setStep] = useState((reduced ?? false) ? STAGES.length + 2 : 0);

  useEffect(() => {
    if (reduced) return;
    if (!inView) {
      setStep(0);
      return;
    }
    let cancelled = false;
    const timers: number[] = [];
    for (let i = 1; i <= STAGES.length; i++) {
      timers.push(window.setTimeout(() => !cancelled && setStep(i), STAGE_DURATION * i));
    }
    timers.push(window.setTimeout(() => !cancelled && setStep(STAGES.length + 1), QUERY_DELAY));
    timers.push(window.setTimeout(() => !cancelled && setStep(STAGES.length + 2), RETRIEVE_DELAY));
    return () => {
      cancelled = true;
      timers.forEach((id) => window.clearTimeout(id));
    };
  }, [inView, reduced]);

  const litStages = Math.min(step, STAGES.length);
  const queryVisible = step > STAGES.length;
  const retrieveVisible = step > STAGES.length + 1;

  return (
    <div ref={ref} className="bg-background flex w-full max-w-lg flex-col gap-4 rounded-xl p-5">
      <div className="text-muted-foreground flex items-center justify-between text-[11px] font-medium tracking-wide uppercase">
        <span>KB ingest pipeline</span>
        <span>per document</span>
      </div>

      {/* ponytail: pipeline row — five boxes connected by arrows.
          The arrow is an SVG line that animates pathLength 0 → 1
          when the target stage lights up. Hardcoded layout, not
          flexbox, so the arrow endpoints line up with the box
          edges regardless of viewport. */}
      <div className="relative">
        <div className="flex items-center justify-between gap-2">
          {STAGES.map((stage, i) => (
            <StageBox key={stage.id} stage={stage} lit={i < litStages} />
          ))}
        </div>
        <ArrowLine
          lit={litStages > 1}
          x1Pct={20}
          x2Pct={40}
          delay={STAGE_DURATION * 0.9}
          visible={!!(inView || reduced)}
        />
        <ArrowLine
          lit={litStages > 2}
          x1Pct={40}
          x2Pct={60}
          delay={STAGE_DURATION * 1.9}
          visible={!!(inView || reduced)}
        />
        <ArrowLine
          lit={litStages > 3}
          x1Pct={60}
          x2Pct={80}
          delay={STAGE_DURATION * 2.9}
          visible={!!(inView || reduced)}
        />
      </div>

      {/* ponytail: retrieval layer only renders after the pipeline
          completes — the visual claim is "all that work paid off
          here". Query card uses the same chrome as the chat input
          (border + muted background) so it reads as part of the
          same flow. */}
      <div className="border-border/60 flex min-h-[88px] flex-col gap-2 border-t pt-3">
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
          <SparklesIcon className="text-primary mt-0.5 size-3.5 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-foreground/90 text-xs leading-snug">
              <span className="text-muted-foreground">[chunk 7 · vector + entity hit · 0.94]</span>{" "}
              The BM25 leg finds the exact term; the entity leg ties it to the canonical name.
            </p>
          </div>
        </m.div>
      </div>
    </div>
  );
};

const StageBox = ({ stage, lit }: { stage: Stage; lit: boolean }) => (
  <m.div
    initial={{ opacity: 0, scale: 0.92 }}
    animate={lit ? { opacity: 1, scale: 1 } : { opacity: 0.5, scale: 0.96 }}
    transition={{ duration: 0.25, ease: "easeOut" }}
    className={cn(
      "border-border/40 bg-muted/30 text-muted-foreground flex size-12 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg border font-mono",
      lit && stage.lit,
    )}
    aria-label={stage.label}
  >
    {stage.id === "pdf" ? (
      <FileTextIcon className="size-4" aria-hidden />
    ) : (
      <span className="text-[10px] font-medium tracking-wide uppercase">{stage.label}</span>
    )}
    <span className="text-[8px] tracking-wide uppercase opacity-70">{stage.label}</span>
  </m.div>
);

// ponytail: arrow as an absolutely-positioned SVG line. Lives in a
// relative parent so we can map x1/x2 percentages to the same row.
// `pathLength` animation is the canonical Motion way to "draw" a
// line — without it the line just appears at full opacity.
const ArrowLine = ({
  lit,
  x1Pct,
  x2Pct,
  delay,
  visible,
}: {
  lit: boolean;
  x1Pct: number;
  x2Pct: number;
  delay: number;
  visible: boolean;
}) => (
  <svg
    aria-hidden
    className="pointer-events-none absolute inset-0 h-full w-full"
    preserveAspectRatio="none"
  >
    <m.line
      x1={`${x1Pct}%`}
      y1="50%"
      x2={`${x2Pct}%`}
      y2="50%"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      className={cn("transition-colors duration-300", lit ? "text-primary" : "text-border")}
      initial={{ pathLength: 0, opacity: 0 }}
      animate={visible && lit ? { pathLength: 1, opacity: 1 } : { pathLength: 0, opacity: 0 }}
      transition={{ duration: 0.3, ease: "easeOut", delay }}
    />
  </svg>
);
