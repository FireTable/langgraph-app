"use client";

// ponytail: hero preview. Types the assistant reply once, then
// idles on the final frame with a fading caret — the visual story
// is "tokens streamed, message delivered", not "demo on loop". A
// `useRef` holds the interval id so the updater can clear itself
// when it hits the end (calling clearInterval from inside the
// setShown callback is the only way to stop a chained setInterval
// once the closure no longer has the id in scope).

import { m, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

const FULL_REPLY =
  "Streaming chat backed by a LangGraph StateGraph, with a second graph that quietly handles memory + observability.";

const USER_PROMPT = "What is this project?";

const CHARS_PER_TICK = 3;
const TICK_MS = 28;
const TYPING_DURATION_MS = (FULL_REPLY.length / CHARS_PER_TICK) * TICK_MS;
const CARET_FADE_DELAY_MS = TYPING_DURATION_MS + 1200;
const CARET_FADE_DURATION_MS = 600;

export const StreamingPreview = () => {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(reduced ? FULL_REPLY.length : 0);
  const [caretVisible, setCaretVisible] = useState(!reduced);
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    if (reduced) return;
    intervalRef.current = window.setInterval(() => {
      setShown((s) => {
        if (s >= FULL_REPLY.length) {
          if (intervalRef.current !== null) {
            window.clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
          return s;
        }
        return Math.min(s + CHARS_PER_TICK, FULL_REPLY.length);
      });
    }, TICK_MS);
    const fadeId = window.setTimeout(() => setCaretVisible(false), CARET_FADE_DELAY_MS);
    return () => {
      if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
      window.clearTimeout(fadeId);
    };
  }, [reduced]);

  const reply = FULL_REPLY.slice(0, shown);

  return (
    // ponytail: tool-call-glow-host reuses the interrupt-shimmer
    // conic ring from app/globals.css (the same one that fires on
    // a real LangGraph `__interrupt__`). The data-slot target ends
    // in "-card" so the CSS selector `tool-call-glow-host
    // [data-slot$="-card"]` matches.
    <div className="tool-call-glow-host" data-slot="chat-preview-card-wrapper">
      <div
        data-slot="chat-preview-card"
        className="border-border/60 bg-card text-card-foreground w-full max-w-md overflow-hidden rounded-2xl border shadow-sm"
      >
        <div className="border-border/60 flex items-center gap-2 border-b px-4 py-2.5">
          <span className="size-2 rounded-full bg-emerald-500" aria-hidden />
          <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Agent
          </span>
        </div>
        <div className="flex flex-col gap-4 p-5">
          <div className="flex justify-end">
            <div className="bg-primary text-primary-foreground max-w-[80%] rounded-2xl rounded-br-sm px-3 py-2 text-sm">
              {USER_PROMPT}
            </div>
          </div>
          <div className="flex justify-start">
            <div className="bg-muted/60 text-foreground/90 max-w-[90%] rounded-2xl rounded-bl-sm px-3 py-2 text-sm leading-relaxed">
              <span>{reply}</span>
              {caretVisible && (
                <m.span
                  aria-hidden
                  initial={{ opacity: 0.9 }}
                  animate={{ opacity: caretVisible ? [0.9, 0.2, 0.9] : 0 }}
                  transition={{ duration: 0.9, repeat: Infinity, ease: "linear" }}
                  className="bg-foreground/70 ml-0.5 inline-block h-3 w-[2px] translate-y-[1px] align-middle"
                  style={{ transitionDuration: `${CARET_FADE_DURATION_MS}ms` }}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
