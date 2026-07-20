"use client";

import { useEffect, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// ponytail: small pulsing dot in the table header that lights up
// when the auto-refresh loop is active. The tooltip counts down to
// the next refresh so the user has a sense of when the table will
// land on fresh data — useful during reprocess / upload windows when
// the doc rows look stuck on a stale status.
//
// `active` is the parent's view of "polling is running right now";
// when it flips false, the indicator unmounts. The internal
// countdown is best-effort (resets every `intervalMs`) — the actual
// refresh fires a few hundred ms after the timer hits 0, which is
// close enough that the user never notices the drift.
export function LivePollIndicator({
  active,
  intervalMs,
  className,
}: {
  active: boolean;
  intervalMs: number;
  className?: string;
}) {
  const [secondsLeft, setSecondsLeft] = useState(Math.ceil(intervalMs / 1000));

  useEffect(() => {
    if (!active) return;
    setSecondsLeft(Math.ceil(intervalMs / 1000));
    const t = setInterval(() => {
      setSecondsLeft((s) => (s <= 1 ? Math.ceil(intervalMs / 1000) : s - 1));
    }, 1000);
    return () => clearInterval(t);
  }, [active, intervalMs]);

  if (!active) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Auto-refreshing"
          // ponytail: 0-padding around the dot so the hover target
          // is comfortable to land on (the dot itself is 8px wide).
          className={cn(
            "relative flex size-6 items-center justify-center rounded-md text-muted-foreground/70 hover:text-foreground",
            className,
          )}
        >
          <span className="relative flex h-2 w-2">
            {/* ponytail: emerald-500 — the conventional "live / healthy"
                indicator color. Primary is whatever the app's accent
                is (sometimes near-black in dark mode), which made
                the dot read as dead/broken. */}
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Auto-refresh in {secondsLeft}s</TooltipContent>
    </Tooltip>
  );
}
