"use client";

import { useEffect, useState } from "react";
import { Infinity as InfinityIcon } from "lucide-react";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Card, CardContent } from "@/components/ui/card";
import { creditTierClass, creditTierFor } from "@/components/credit/credit-progress";
import { loadCreditStatus, peekCachedStatus, type CreditStatus } from "@/lib/credit/status";

function formatCredits(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(2);
}

function formatHours(h: number): string {
  return h === 1 ? "1h" : `${h}h`;
}

function WindowQuotaCard({ status }: { status: CreditStatus }) {
  const { used, limit, windowHours, unlimited } = status;

  if (unlimited || limit == null || windowHours == null) {
    return (
      <Card className="bg-transparent py-3 flex flex-col justify-between">
        <CardContent className="flex flex-col gap-1.5 px-3">
          <div className="flex items-center justify-between">
            <div className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
              Window Quota
            </div>
            <span className="text-muted-foreground/70 font-mono text-[10px]">Unmetered</span>
          </div>

          <div className="flex items-baseline gap-1.5">
            <span className="text-foreground text-lg font-semibold tabular-nums">Unlimited</span>
            <span className="text-muted-foreground text-[11px]">credits</span>
          </div>

          <div className="mt-1 flex flex-col gap-1">
            <div className="h-2 w-full overflow-hidden rounded-full bg-primary/20 flex">
              <div className="w-full bg-primary h-full" />
            </div>
            <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground">
              <div className="flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-primary inline-block shrink-0" />
                <span>Status: Active</span>
              </div>
              <div className="flex items-center gap-1">
                <span>No cap</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const remaining = Math.max(0, limit - used);
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const tier = creditTierFor(pct);

  return (
    <Card className="bg-transparent py-3 flex flex-col justify-between">
      <CardContent className="flex flex-col gap-1.5 px-3">
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
            Window Quota
          </div>
          <span className="text-muted-foreground/70 font-mono text-[10px]">
            {formatHours(windowHours)} rolling
          </span>
        </div>

        <div className="flex items-baseline gap-1.5">
          <span className="text-foreground text-lg font-semibold tabular-nums">
            {formatCredits(remaining)}
          </span>
          <span className="text-muted-foreground text-[11px]">remaining</span>
        </div>

        <div className="mt-1 flex flex-col gap-1">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="bg-muted-foreground/15 h-2 w-full overflow-hidden rounded-full cursor-pointer flex">
                  <div
                    className={`h-full rounded-full transition-all ${creditTierClass(tier)}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs font-mono flex flex-col gap-0.5">
                <div>
                  used: {formatCredits(used)} ({pct}%)
                </div>
                <div>limit: {formatCredits(limit)} credits</div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground">
            <div className="flex items-center gap-1">
              <span className="size-1.5 rounded-full bg-primary inline-block shrink-0" />
              <span>
                Used: {formatCredits(used)} ({pct}%)
              </span>
            </div>
            <div className="flex items-center gap-1">
              <span>Limit: {formatCredits(limit)}</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function UsageStatCard({
  title,
  credits,
  inputTokens,
  outputTokens,
}: {
  title: string;
  credits: number;
  inputTokens: number;
  outputTokens: number;
}) {
  const totalTokens = inputTokens + outputTokens;
  const inputPct = totalTokens > 0 ? (inputTokens / totalTokens) * 100 : 0;
  const outputPct = totalTokens > 0 ? 100 - inputPct : 0;

  return (
    <Card className="bg-transparent py-3 flex flex-col justify-between">
      <CardContent className="flex flex-col gap-1.5 px-3">
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
            {title}
          </div>
          <span className="text-muted-foreground/70 font-mono text-[10px]">
            {totalTokens.toLocaleString()} tok
          </span>
        </div>

        <div className="flex items-baseline gap-1.5">
          <span className="text-foreground text-lg font-semibold tabular-nums">
            {credits.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </span>
          <span className="text-muted-foreground text-[11px]">credit</span>
        </div>

        <div className="mt-1 flex flex-col gap-1">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted flex cursor-pointer">
                  {totalTokens > 0 ? (
                    <>
                      <div
                        style={{ width: `${inputPct}%` }}
                        className="bg-primary h-full transition-all duration-300"
                      />
                      <div
                        style={{ width: `${outputPct}%` }}
                        className="bg-emerald-500/80 h-full transition-all duration-300"
                      />
                    </>
                  ) : (
                    <div className="w-full bg-muted-foreground/15 h-full" />
                  )}
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs font-mono flex flex-col gap-0.5">
                <div>
                  input: {inputTokens.toLocaleString()} tok ({inputPct.toFixed(1)}%)
                </div>
                <div>
                  output: {outputTokens.toLocaleString()} tok ({outputPct.toFixed(1)}%)
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground">
            <div className="flex items-center gap-1">
              <span className="size-1.5 rounded-full bg-primary inline-block shrink-0" />
              <span>In: {inputTokens.toLocaleString()}</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="size-1.5 rounded-full bg-emerald-500/80 inline-block shrink-0" />
              <span>Out: {outputTokens.toLocaleString()}</span>
            </div>
          </div>
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
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      <WindowQuotaCard status={status} />
      <UsageStatCard
        title="Today's Usage"
        credits={status.todayCredits ?? 0}
        inputTokens={status.todayInputTokens ?? 0}
        outputTokens={status.todayOutputTokens ?? 0}
      />
      <UsageStatCard
        title="Total Usage"
        credits={status.totalCredits ?? 0}
        inputTokens={status.totalInputTokens ?? 0}
        outputTokens={status.totalOutputTokens ?? 0}
      />
    </div>
  );
}

export function CreditSummarySection(): React.JSX.Element {
  return (
    <section>
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">Window credits</h2>
      <p className="text-muted-foreground mb-3 text-xs leading-relaxed">
        Credits charged to your account in the last rolling window. Resets when the oldest in-window
        call ages out.
      </p>
      <CreditSummaryCard />
    </section>
  );
}
