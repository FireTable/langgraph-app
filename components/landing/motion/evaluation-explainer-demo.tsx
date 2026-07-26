"use client";

// ponytail: Evaluation explainer. Direction is the *reverse* of the
// KB explainer — KB animates ingest → embed (left → right); Eval
// animates a finished run on the left → a judge on the right
// that reads it, lights up criteria, and stamps scores back onto
// the run. The visual story is "scoring goes backwards through
// the pipeline".
//
//   Run bubble (user + assistant)        Judge card
//   ┌──────────────────────┐     →      ┌──────────────────┐
//   │ user:  capital of FR?  │           │ ⚖ Judge          │
//   │ ai:    Paris.           │           │ ─ relevance  ●●●●● 5 │
//   │                        │           │ ─ accuracy   ●●●●○ 4 │
//   │   ← score 4.5 / 5      │           │ reasoning: …       │
//   └──────────────────────┘           └──────────────────┘
//
// Animation order (scroll-driven):
//   1. User message bubble fades in
//   2. Assistant reply slides in beneath
//   3. Judge icon slides in from the right edge
//   4. Criteria rows light up right-to-left (the "reading")
//   5. Score dots fill in sequence
//   6. Reasoning card slides up under the judge

import { m, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { BrainIcon, ScaleIcon, SparklesIcon } from "lucide-react";

import { cn } from "@/lib/utils";

type Criterion = {
  key: string;
  label: string;
  score: number; // 0..5
  weight: number; // 0..1, controls dot count colour intensity
  hue: string; // tailwind key into HUE map (literal classes registered below)
};

// ponytail: literal Tailwind classes so JIT picks them up. Dynamic
// `bg-${hue}-500` strings would silently no-op (no class emitted
// at build). Same trick as the KB explainer's PALETTE.
type HueEntry = { icon: string; dot: string };
const HUE: Record<string, HueEntry> = {
  emerald: { icon: "text-emerald-500", dot: "bg-emerald-500" },
  violet: { icon: "text-violet-500", dot: "bg-violet-500" },
};

const CRITERIA: Criterion[] = [
  { key: "relevance", label: "relevance", score: 5, weight: 0.5, hue: "emerald" },
  { key: "accuracy", label: "accuracy", score: 4, weight: 0.5, hue: "violet" },
];

const STEP = 220; // ms between timeline steps

export const EvaluationExplainerDemo = () => {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.3 });
  const [step, setStep] = useState(reduced ? 99 : 0);

  useEffect(() => {
    if (reduced) return;
    if (!inView) {
      setStep(0);
      return;
    }
    let cancelled = false;
    const timers: number[] = [];
    // Run bubbles → judge → criteria (right-to-left) → scores → reasoning
    const seq: Array<[number, number]> = [
      [1, STEP], // user bubble
      [2, STEP * 2], // assistant bubble
      [3, STEP * 3], // judge card
      [4, STEP * 4], // criteria row 1 lit
      [5, STEP * 5], // criteria row 2 lit
      [6, STEP * 6], // scores stamped
      [7, STEP * 7 + 80], // reasoning card
    ];
    for (const [target, delay] of seq) {
      timers.push(
        window.setTimeout(() => !cancelled && setStep((s) => Math.max(s, target)), delay),
      );
    }
    return () => {
      cancelled = true;
      timers.forEach((id) => window.clearTimeout(id));
    };
  }, [inView, reduced]);

  const userVisible = step >= 1;
  const assistantVisible = step >= 2;
  const judgeVisible = step >= 3;
  const criteriaLitCount = Math.min(Math.max(step - 3, 0), CRITERIA.length);
  const scoresVisible = step >= 6;
  const reasoningVisible = step >= 7;

  return (
    <div ref={ref} className="bg-background flex w-full max-w-lg flex-col gap-4 rounded-xl p-5">
      <div className="text-muted-foreground flex flex-col gap-0.5 text-[11px] font-medium tracking-wide uppercase">
        <span>Evaluation · AI Judge</span>
        <span className="text-muted-foreground/70 text-[10px] font-normal normal-case tracking-normal">
          run → criteria → score
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-stretch">
        {/* Left column: run bubble pair */}
        <div className="flex flex-col gap-2">
          <m.div
            initial={{ opacity: 0, y: 4 }}
            animate={userVisible ? { opacity: 1, y: 0 } : { opacity: 0, y: 4 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="border-border/60 bg-muted/30 ml-auto max-w-[85%] rounded-lg border px-3 py-2 text-xs"
          >
            <span className="text-muted-foreground">user · </span>
            <span className="text-foreground/90">What&apos;s the capital of France?</span>
          </m.div>
          <m.div
            initial={{ opacity: 0, y: 6 }}
            animate={assistantVisible ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="border-primary/30 bg-primary/5 max-w-[85%] rounded-lg border px-3 py-2 text-xs"
          >
            <span className="text-muted-foreground">assistant · </span>
            <span className="text-foreground/90">Paris.</span>
          </m.div>
          <m.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={scoresVisible ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.9 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="mt-1 flex items-center gap-1.5 self-start text-[10px] font-medium tracking-wide uppercase"
          >
            <SparklesIcon className="text-amber-500 size-3" aria-hidden />
            <span className="text-foreground/80">
              overall <span className="text-amber-600 dark:text-amber-400">4.5 / 5</span>
            </span>
          </m.div>
        </div>

        {/* Middle: arrow connector */}
        <div className="flex items-center justify-center sm:flex-col sm:py-3">
          <m.div
            initial={{ opacity: 0 }}
            animate={judgeVisible ? { opacity: 1 } : { opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="text-muted-foreground/60 flex items-center"
            aria-hidden
          >
            <span className="bg-border/60 h-px w-6 sm:h-6 sm:w-px" />
          </m.div>
        </div>

        {/* Right column: judge card */}
        <m.div
          initial={{ opacity: 0, x: 12 }}
          animate={judgeVisible ? { opacity: 1, x: 0 } : { opacity: 0, x: 12 }}
          transition={{ duration: 0.35, ease: "easeOut" }}
          className="border-border/60 bg-muted/30 flex flex-col gap-3 rounded-lg border p-3"
        >
          <div className="flex items-center gap-2">
            <div className="bg-violet-500/15 text-violet-700 dark:text-violet-300 flex size-7 items-center justify-center rounded-full ring-1 ring-violet-500/30 ring-inset">
              <ScaleIcon className="size-3.5" aria-hidden />
            </div>
            <div className="flex flex-col">
              <span className="text-foreground/90 text-xs font-semibold">judgeByLLM</span>
              <span className="text-muted-foreground text-[10px] font-normal">
                rubric · chatAgent
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            {CRITERIA.map((c, i) => {
              const lit = i < criteriaLitCount;
              return (
                <div
                  key={c.key}
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 transition-colors duration-300",
                    lit ? "border-border/60 bg-background" : "border-transparent bg-transparent",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <BrainIcon
                      className={cn(
                        "size-3 shrink-0 transition-colors",
                        lit ? HUE[c.hue].icon : "text-muted-foreground/40",
                      )}
                      aria-hidden
                    />
                    <span
                      className={cn(
                        "text-[11px] font-medium transition-colors",
                        lit ? "text-foreground/90" : "text-muted-foreground/50",
                      )}
                    >
                      {c.label}
                    </span>
                  </div>
                  <ScoreDots score={c.score} lit={scoresVisible} hue={c.hue} />
                </div>
              );
            })}
          </div>

          <m.div
            initial={{ opacity: 0, y: 4 }}
            animate={reasoningVisible ? { opacity: 1, y: 0 } : { opacity: 0, y: 4 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="border-border/40 bg-background/60 rounded-md border p-2 text-[11px] leading-snug"
          >
            <span className="text-muted-foreground">reasoning · </span>
            <span className="text-foreground/85">
              accurate, concise; could acknowledge the user&apos;s framing.
            </span>
          </m.div>
        </m.div>
      </div>

      <div className="text-muted-foreground flex items-start gap-2 text-[11px] leading-snug">
        <ScaleIcon className="text-muted-foreground mt-0.5 size-3 shrink-0" aria-hidden />
        <span>
          The judge reads the same span context the model produced — same input, same output — then
          stamps a per-criterion score + reasoning. Online executions surface every run; benchmarks
          replay one input against a target agent under the same harness.
        </span>
      </div>
    </div>
  );
};

// ponytail: 5-dot score chip. Filled dots = score; the rest stay
// muted. Each criterion carries its own hue (emerald / violet / …)
// so a side-by-side read of "relevance 5 emerald, accuracy 4
// violet" lands instantly.
const ScoreDots = ({ score, lit, hue }: { score: number; lit: boolean; hue: string }) => (
  <div className="flex items-center gap-0.5" aria-hidden>
    {[1, 2, 3, 4, 5].map((i) => {
      const filled = i <= score;
      return (
        <m.span
          key={i}
          initial={{ scale: 0, opacity: 0 }}
          animate={lit && filled ? { scale: 1, opacity: 1 } : { scale: 1, opacity: 0.18 }}
          transition={{ duration: 0.2, ease: "easeOut", delay: (i - 1) * 0.04 }}
          className={cn(
            "inline-block size-1.5 rounded-full",
            lit && filled ? HUE[hue].dot : "bg-muted-foreground/30",
          )}
        />
      );
    })}
    <span
      className={cn(
        "ml-1 text-[10px] font-mono font-semibold transition-colors",
        lit ? "text-foreground/80" : "text-muted-foreground/40",
      )}
    >
      {score}
    </span>
  </div>
);
