"use client";

// ponytail: just the interrupt card — no surrounding chat. The
// hero already carries the conversation flow; this section zooms
// in on the moment that matters (the tool-call UI the human
// actually interacts with). Same warm shimmer
// (.tool-call-glow-host) the real chat surface uses on
// `__interrupt__` — see docs/INTERRUPT.md and
// components/observability/panel.tsx for the production reference.

import { AlertCircleIcon, ChevronRightIcon, MapPinIcon, PencilLineIcon } from "lucide-react";

export const HumanInTheLoopDemo = () => (
  <div className="w-full max-w-md">
    <div className="tool-call-glow-host" data-slot="human-in-the-loop-card-wrapper">
      <div
        data-slot="human-in-the-loop-card"
        className="bg-card text-card-foreground border-border/60 overflow-hidden rounded-2xl border"
      >
        <div className="text-amber-700 dark:text-amber-400 bg-amber-500/10 border-amber-500/30 flex items-center gap-1.5 border-b px-3 py-2 text-[11px] font-medium tracking-wide uppercase">
          <AlertCircleIcon className="size-3" aria-hidden />
          Awaiting tool-call
          <code className="bg-background/60 text-foreground ml-1 rounded px-1.5 py-0.5 font-mono text-[11px] normal-case tracking-normal">
            ask_location
          </code>
        </div>
        <div className="flex flex-col gap-2.5 px-3 py-3 text-sm">
          <p className="text-muted-foreground text-xs leading-relaxed">
            Share your location so the agent can pull the forecast.
          </p>
          <div className="flex flex-col gap-1.5">
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
        </div>
      </div>
    </div>
    <p className="text-muted-foreground mt-3 text-center text-xs">
      Tool execution paused — the graph resumes on click.
    </p>
  </div>
);
