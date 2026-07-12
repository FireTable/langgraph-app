"use client";

// ponytail: shared visual primitive for the rolling-window credit
// indicator. Used in two surfaces that have to read the same:
//
//   1. <CreditUsageSlot /> inside UserButton — a compact
//      "Used X / Y · pct%" line + a horizontal bar.
//   2. <QuotaCard /> as a tool call in the chat — a wider card
//      that says "Credit limit reached" with the same numbers.
//
// Keeping them in one place is the only way to make sure the
// numbers and the color story (primary → amber → destructive) line
// up across the two surfaces; the proxy gate that blocks the turn
// hands the same `resetAt / limit / used / windowHours` payload
// to both, so they cannot drift.
//
// The label variants (`slot` / `card`) only change chrome and the
// wording of the secondary line — the bar geometry and the tier
// coloring stay identical so muscle memory transfers between the
// two surfaces.

import { CoinsIcon } from "lucide-react";
import type { ReactNode } from "react";

export type QuotaTier = "normal" | "warn" | "over";

export function tierFor(pct: number): QuotaTier {
  if (pct >= 100) return "over";
  if (pct >= 80) return "warn";
  return "normal";
}

export function tierClass(tier: QuotaTier): string {
  switch (tier) {
    case "over":
      return "bg-destructive";
    case "warn":
      return "bg-amber-500";
    case "normal":
      return "bg-primary";
  }
}

function formatCredits(n: number): string {
  return Number.isInteger(n) ? n.toString() : n.toFixed(2);
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export type QuotaProgressProps = {
  variant: "slot" | "card";
  used: number;
  limit: number;
  windowHours: number;
  resetAt: Date | string;
};

export function QuotaProgress({
  variant,
  used,
  limit,
  windowHours,
  resetAt,
}: QuotaProgressProps): ReactNode {
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const tier = tierFor(pct);
  const resetTime = formatTime(typeof resetAt === "string" ? resetAt : resetAt.toISOString());
  const usedStr = formatCredits(used);
  const limitStr = formatCredits(limit);

  // ponytail: only the surrounding chrome differs between variants —
  // slot (dropdown row, tight spacing, no card chrome) vs. card
  // (tool-ui card with title). Geometry of the bar is identical so
  // the percentage reads the same in both contexts.
  if (variant === "slot") {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2 pb-1.5 text-sm font-normal">
          <CoinsIcon className="size-4 shrink-0 text-muted-foreground " />
          <span>Usage</span>
        </div>
        <div className="text-muted-foreground pl-6 text-xs">
          Used <span className="text-foreground font-medium">{usedStr}</span> / {limitStr} credits
        </div>
        <div className="flex items-center gap-2 pl-6">
          <div
            className="bg-muted-foreground/15 relative h-1.5 flex-1 overflow-hidden rounded-full"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${usedStr} of ${limitStr} credits used`}
          >
            <div
              className={`h-full rounded-full transition-all ${tierClass(tier)}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="shrink-0 text-[11px] tabular-nums">{pct}%</span>
        </div>
        <div className="text-muted-foreground/80 pl-6 text-[11px]">
          Reached {windowHours}h window · resets at {resetTime}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 pl-12">
      <div className="text-muted-foreground text-xs">
        Used <span className="text-foreground font-medium">{usedStr}</span> / {limitStr} credits
      </div>
      <div className="flex items-center gap-2">
        <div
          className="bg-muted-foreground/15 relative h-1.5 flex-1 overflow-hidden rounded-full"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${usedStr} of ${limitStr} credits used`}
        >
          <div
            className={`h-full rounded-full transition-all ${tierClass(tier)}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="shrink-0 text-xs tabular-nums">{pct}%</span>
      </div>
      <p className="text-muted-foreground text-xs">
        Reached {windowHours}h rolling window · resets at {resetTime}. Try again when the window
        rolls forward, or contact your admin to raise the limit.
      </p>
    </div>
  );
}
