"use client";

// ponytail: hero preview. Types the assistant reply once, then a
// LangGraph-style interrupt card surfaces inside the same hero
// frame — same conversation thread, same card chrome, just a
// smaller compact tool row the visitor can approve. Reuses the
// warm conic-ring shimmer from app/globals.css
// (.tool-call-glow-host) — same visual language as a real
// `__interrupt__` would carry in the chat UI. After the user
// clicks Confirm/Decline the ring fades out so the resolved state
// reads as "done".

import { m, useReducedMotion } from "motion/react";
import { AlertCircleIcon, CheckIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

const FULL_REPLY =
  "Streaming chat backed by a LangGraph StateGraph, with a second graph that quietly handles memory + observability.";

const USER_PROMPT = "What is this project?";

const CHARS_PER_TICK = 3;
const TICK_MS = 28;
const TYPING_DURATION_MS = (FULL_REPLY.length / CHARS_PER_TICK) * TICK_MS;
const CARET_FADE_DELAY_MS = TYPING_DURATION_MS + 1200;
const CARET_FADE_DURATION_MS = 600;
const INTERRUPT_DELAY_MS = TYPING_DURATION_MS + 800;

type InterruptVerdict = "confirmed" | "declined";

export const StreamingPreview = () => {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(reduced ? FULL_REPLY.length : 0);
  const [caretVisible, setCaretVisible] = useState(!reduced);
  const [interruptShown, setInterruptShown] = useState(false);
  const [verdict, setVerdict] = useState<InterruptVerdict | null>(null);
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
    const interruptId = window.setTimeout(() => setInterruptShown(true), INTERRUPT_DELAY_MS);
    return () => {
      if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
      window.clearTimeout(fadeId);
      window.clearTimeout(interruptId);
    };
  }, [reduced]);

  const reply = FULL_REPLY.slice(0, shown);
  // ponytail: pulse the dot + bars while the agent is actively
  // doing something — typing tokens, or holding the interrupt
  // card open. Resolved (Confirm/Decline) or fully typed + idle
  // collapses back to static. Reuses the same staggered-bar
  // pattern as Features' `StreamingHint`.
  const isLive = shown < FULL_REPLY.length || (interruptShown && verdict === null);

  return (
    // ponytail: only the interrupt card gets the warm shimmer ring
    // (`.tool-call-glow-host` + `[data-slot$="-card"]` selector in
    // app/globals.css). The hero frame around the whole conversation
    // stays unadorned — otherwise every card on the page would
    // compete for attention and the interrupt's affordance loses its
    // punch.
    <div className="w-full max-w-md">
      <div
        data-slot="chat-preview-card"
        className="border-border/60 bg-card text-card-foreground overflow-hidden rounded-2xl border shadow-sm"
      >
        <div className="border-border/60 flex items-center gap-3 border-b px-4 py-2.5">
          <span
            className={cn(
              "size-2 rounded-full bg-emerald-500",
              isLive && !reduced && "animate-pulse",
            )}
            aria-hidden
          />
          <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Agent
          </span>
          {isLive && !reduced && (
            <div className="flex items-center gap-1" aria-hidden>
              {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                <span
                  key={i}
                  className="bg-foreground/70 inline-block h-1 rounded-full"
                  style={{
                    width: 3 + ((i * 5) % 8),
                    animation: "aui-pulse 1.4s ease-in-out infinite",
                    animationDelay: `${i * 0.12}s`,
                  }}
                />
              ))}
            </div>
          )}
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
          {interruptShown && (
            <div
              className="tool-call-glow-host flex justify-start"
              data-slot="interrupt-tool-card-wrapper"
              data-shimmer={verdict ? "off" : "on"}
            >
              <m.div
                data-slot="interrupt-tool-card"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, ease: "easeOut" }}
                className={cn(
                  "bg-background border-border/60 flex w-full max-w-[90%] flex-col gap-2 rounded-2xl rounded-bl-sm border px-3 py-2.5 text-sm",
                  verdict === "confirmed" && "border-emerald-500/30 bg-emerald-500/5",
                  verdict === "declined" && "bg-muted/30",
                )}
              >
                <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase">
                  {verdict === "confirmed" ? (
                    <>
                      <CheckIcon
                        className="size-3 text-emerald-600 dark:text-emerald-400"
                        aria-hidden
                      />
                      <span className="text-emerald-700 dark:text-emerald-400">Approved</span>
                    </>
                  ) : verdict === "declined" ? (
                    <>
                      <XIcon className="text-muted-foreground size-3" aria-hidden />
                      <span className="text-muted-foreground">Declined</span>
                    </>
                  ) : (
                    <>
                      <AlertCircleIcon
                        className="text-amber-600 size-3 dark:text-amber-400"
                        aria-hidden
                      />
                      <span className="text-amber-700 dark:text-amber-400">Requires approval</span>
                    </>
                  )}
                  <code className="bg-muted/60 text-foreground ml-1 rounded px-1.5 py-0.5 font-mono text-[11px] normal-case tracking-normal">
                    explore_mode
                  </code>
                </div>
                {verdict === null ? (
                  <p className="text-muted-foreground text-xs leading-relaxed">
                    Try the streaming reply plus the side panels — graph, memory, traces — at once.
                  </p>
                ) : (
                  <p className="text-muted-foreground text-xs leading-relaxed">
                    {verdict === "confirmed"
                      ? "On. You'll see the side panels stream live alongside each reply."
                      : "Off. The next turn will be chat-only."}
                  </p>
                )}
                {verdict === null && (
                  <div className="flex items-center justify-end gap-1.5 pt-0.5">
                    <button
                      type="button"
                      onClick={() => setVerdict("declined")}
                      className="border-border/60 bg-background text-foreground hover:bg-muted/60 inline-flex h-7 items-center rounded-md border px-2.5 text-xs font-medium transition-colors"
                    >
                      Decline
                    </button>
                    <button
                      type="button"
                      onClick={() => setVerdict("confirmed")}
                      className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium transition-colors"
                    >
                      Confirm
                    </button>
                  </div>
                )}
              </m.div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
