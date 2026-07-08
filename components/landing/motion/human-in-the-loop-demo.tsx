"use client";

// ponytail: same chrome as the hero interrupt card
// (components/landing/motion/streaming-preview.tsx) so the
// How-it-works demo reads as the same primitive. Hero's
// `data-slot="interrupt-tool-card"` is the production reference
// — see docs/INTERRUPT.md. Only deviation: ask_location is an
// open input (browser permission or text entry), not an
// approve/decline pair, so the action row is two item buttons
// instead of a Decline/Confirm pair.

import { m } from "motion/react";
import { AlertCircleIcon, ChevronRightIcon, MapPinIcon, PencilLineIcon } from "lucide-react";

export const HumanInTheLoopDemo = () => (
  <div className="w-full max-w-md">
    <div className="tool-call-glow-host flex justify-start" data-slot="interrupt-tool-card-wrapper">
      <m.div
        data-slot="interrupt-tool-card"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
        className="bg-background border-border/60 flex w-full max-w-[90%] flex-col gap-2 rounded-2xl rounded-bl-sm border px-3 py-2.5 text-sm"
      >
        <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase">
          <AlertCircleIcon className="text-amber-600 size-3 dark:text-amber-400" aria-hidden />
          <span className="text-amber-700 dark:text-amber-400">Requires approval</span>
          <code className="bg-muted/60 text-foreground ml-1 rounded px-1.5 py-0.5 font-mono text-[11px] normal-case tracking-normal">
            ask_location
          </code>
        </div>
        <p className="text-muted-foreground text-xs leading-relaxed">
          Share your location so the agent can pull the forecast.
        </p>
        <div className="flex flex-col gap-1.5 pt-0.5">
          <button
            type="button"
            className="border-border/60 bg-background text-foreground hover:bg-muted/60 flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors"
          >
            <span className="flex items-center gap-2">
              <MapPinIcon className="text-muted-foreground size-3.5" aria-hidden />
              Use my location
            </span>
            <ChevronRightIcon className="text-muted-foreground size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            className="border-border/60 bg-background text-foreground hover:bg-muted/60 flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors"
          >
            <span className="flex items-center gap-2">
              <PencilLineIcon className="text-muted-foreground size-3.5" aria-hidden />
              Type a city
            </span>
            <ChevronRightIcon className="text-muted-foreground size-3.5" aria-hidden />
          </button>
        </div>
      </m.div>
    </div>
    <p className="text-muted-foreground mt-3 text-center text-xs">
      Tool execution paused — the graph resumes on click.
    </p>
  </div>
);
