"use client";

// ponytail: tokens-reveal demo. Plays once on scroll into view:
// tokens appear one at a time, then the panel holds the final
// state. No reset loop — the user reads the line, the demo stops.
// Use of `m` (not `motion`) is the LazyMotion-compatible
// shorthand — full `motion.span` would re-import the full feature
// set and defeat the bundle savings from `domAnimation`.

import { m, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

const TOKENS = [
  "The",
  " chat",
  " graph",
  " routes",
  " to",
  " a",
  " sub-agent.",
  " The",
  " sub-agent",
  " picks",
  " tools",
  " and",
  " streams",
  " tokens",
  " back",
  " to",
  " the",
  " runtime.",
  " Each",
  " emitted",
  " token",
  " is",
  " appended",
  " in",
  " place",
  " to",
  " the",
  " message.",
  " Aborts",
  " cancel",
  " at",
  " the",
  " SDK",
  " layer",
  " and",
  " never",
  " reach",
  " the",
  " database.",
];

const TICK_MS = 180;
// ponytail: fade-in MUST finish before the next tick so each
// token is fully revealed when the next appears — otherwise the
// eye reads a glow trail instead of distinct words landing.
const TOKEN_FADE_S = 0.32;

export const StreamingTokensDemo = () => {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });
  const [count, setCount] = useState(reduced ? TOKENS.length : 0);

  useEffect(() => {
    if (reduced) return;
    if (!inView) {
      setCount(0);
      return;
    }
    // ponytail: chained setTimeout, no reset. The counter walks
    // 0 → TOKENS.length once, then stops. A looping reveal
    // re-reads as a countdown rather than a stream.
    let timeoutId = 0;
    let cancelled = false;
    const step = () => {
      if (cancelled) return;
      setCount((c) => {
        if (c >= TOKENS.length) return c;
        timeoutId = window.setTimeout(step, TICK_MS);
        return c + 1;
      });
    };
    timeoutId = window.setTimeout(step, TICK_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [inView, reduced]);

  return (
    <div
      ref={ref}
      className="bg-background flex w-full max-w-md flex-col gap-3 rounded-xl p-4 font-mono text-xs leading-relaxed"
    >
      <div className="text-muted-foreground flex items-center justify-between">
        <span>Stream</span>
        <span>
          {String(count).padStart(2, "0")} / {String(TOKENS.length).padStart(2, "0")}
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        {TOKENS.map((token, i) => {
          const visible = i < count;
          return (
            <m.span
              key={`${token}-${i}`}
              initial={{ opacity: 0, y: 4 }}
              animate={visible ? { opacity: 1, y: 0 } : { opacity: 0, y: 4 }}
              transition={{ duration: TOKEN_FADE_S, ease: "easeOut" }}
              className="bg-muted/60 text-foreground/90 rounded px-1.5 py-0.5"
            >
              {token}
            </m.span>
          );
        })}
      </div>
    </div>
  );
};
