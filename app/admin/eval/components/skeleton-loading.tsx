"use client";

import { Skeleton } from "@/components/ui/skeleton";

// ponytail: layout-shaped skeleton for the Eval & A/B Platform.
// Mirrors the dashboard's real shell (header + tabs strip + the
// active tab body) so first paint doesn't visually jump when the
// real content arrives. Subsequent refetches don't use this —
// the dashboard keeps stale data visible and updates in place.
export function SkeletonLoading() {
  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="mt-2 flex flex-col gap-2">
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-3 w-[28rem] max-w-full" />
          </div>
        </div>

        {/* Tabs strip — 3 placeholder pills */}
        <div className="grid grid-cols-1 md:grid-cols-3 h-11 w-full bg-muted/60 p-1 rounded-xl gap-1">
          <Skeleton className="h-full w-full rounded-lg" />
          <Skeleton className="h-full w-full rounded-lg" />
          <Skeleton className="h-full w-full rounded-lg" />
        </div>
      </div>

      {/* Tab body — generic 3-column card grid (Prompts Studio shape) */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="border border-border/80 shadow-2xs rounded-lg overflow-hidden">
            <Skeleton className="h-10 w-full rounded-none" />
            <div className="p-3.5 flex flex-col gap-2">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>

      {/* Below: a long table placeholder */}
      <div className="border border-border/60 rounded-xl overflow-hidden">
        <div className="p-2 bg-muted/40 border-b border-border/40">
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="p-3 flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
