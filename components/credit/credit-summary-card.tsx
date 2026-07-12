"use client";

import { useEffect, useState } from "react";
import { Infinity as InfinityIcon } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { tierClass, tierFor } from "@/components/credit/quota-progress";
import { loadCreditStatus, peekCachedStatus, type CreditStatus } from "@/lib/credit/status";

// ponytail: 4-card stat grid + thin progress bar, rendered as a
// standalone section on the settings/credit page (above call
// history, NOT nested inside it). Same /api/credit/status source
// as the UserButton slot — shared cache in lib/credit/status.ts
// means the two surfaces share a network round-trip when both
// are mounted.
//
// Limited accounts: 4 stat cards in a 1/2/4 column grid + a thin
// progress bar. Admin (unlimited) accounts render a single
// full-width card so the row doesn't look broken.
function formatCredits(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(2);
}

function formatHours(h: number): string {
  return h === 1 ? "1 hour" : `${h} hours`;
}

type StatCardProps = {
  label: string;
  value: string;
  hint?: string;
};

function StatCard({ label, value, hint }: StatCardProps) {
  return (
    <Card className="bg-transparent py-3">
      <CardContent className="flex flex-col gap-1 px-3">
        <div className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
          {label}
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-foreground text-lg font-semibold tabular-nums">{value}</span>
          {hint ? <span className="text-muted-foreground text-[11px]">{hint}</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}

function LimitedView({ status }: { status: CreditStatus }) {
  const { used, limit, windowHours } = status;
  if (limit == null || windowHours == null) return null;
  const remaining = Math.max(0, limit - used);
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const tier = tierFor(pct);

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Used" value={formatCredits(used)} hint="credits" />
        <StatCard label="Remaining" value={formatCredits(remaining)} hint="credits" />
        <StatCard label="Used %" value={`${pct}%`} />
        <StatCard label="Window" value={formatHours(windowHours)} hint="rolling" />
      </div>
      <div
        className="bg-muted-foreground/15 relative mt-3 h-1.5 overflow-hidden rounded-full"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${pct}% of ${formatCredits(limit)} credits used in the last ${formatHours(windowHours)}`}
      >
        <div
          className={`h-full rounded-full transition-all ${tierClass(tier)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </>
  );
}

function UnlimitedView() {
  return (
    <Card className="bg-transparent py-3">
      <CardContent className="flex items-center gap-3 px-3">
        <InfinityIcon className="text-muted-foreground size-5" aria-hidden />
        <div className="flex flex-col">
          <div className="text-sm font-medium">No cap on this account</div>
          <div className="text-muted-foreground text-xs">All calls flow through unmetered.</div>
        </div>
      </CardContent>
    </Card>
  );
}

export function CreditSummaryCard(): React.JSX.Element | null {
  const [status, setStatus] = useState<CreditStatus | null>(peekCachedStatus());

  useEffect(() => {
    let cancelled = false;
    loadCreditStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        // surface-less — the table below shows the same data, and a
        // network blip on the summary should never block the page.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status) return null;

  return (
    <div className="flex flex-col gap-3">
      {status.unlimited ? <UnlimitedView /> : <LimitedView status={status} />}
    </div>
  );
}

export function CreditSummarySection(): React.JSX.Element {
  return (
    <section>
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
        Window Quota
      </h2>
      <p className="text-muted-foreground mb-3 text-xs leading-relaxed">
        Credits charged to your account in the last rolling window. Resets when the oldest in-window
        call ages out.
      </p>
      <CreditSummaryCard />
    </section>
  );
}
