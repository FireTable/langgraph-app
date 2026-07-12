"use client";

import { useEffect, useState } from "react";

import { QuotaHeader } from "@/components/credit/quota-header";
import { QuotaProgress } from "@/components/credit/quota-progress";
import { Skeleton } from "@/components/ui/skeleton";
import { loadCreditStatus, peekCachedStatus, type CreditStatus } from "@/lib/credit/status";

// ponytail: read-only credit-usage indicator rendered inside the
// UserButton dropdown between the user header and the link list.
// Hits /api/credit/status (the same path the proxy uses for its
// quota gate) so the number on the surface and the gate that
// blocks the chat stay in lock-step — a single source of truth
// for "how much have I used". The cache + in-flight promise live
// in lib/credit/status.ts so the UserButton slot and the settings
// page summary card share one network round-trip when both are
// mounted at once (desktop sidebar + settings tab open).
function SlotSkeleton(): React.JSX.Element {
  // ponytail: mirrors the QuotaProgress slot layout (header / used /
  // progress+pct / window hint) so the slot's height stays constant
  // when status lands. Cache hits skip this — peekCachedStatus
  // returns non-null and we render straight away.
  return (
    <div className="flex flex-col gap-2 px-2 py-1.5">
      <QuotaHeader />
      <Skeleton className="ml-6 h-3 w-32" />
      <div className="ml-6 flex items-center gap-2 w-50">
        <Skeleton className="h-2 flex-1 rounded-full" />
        <Skeleton className="h-3 w-7" />
      </div>
      <Skeleton className="ml-6 h-3 w-42" />
    </div>
  );
}

export function CreditUsageSlot(): React.JSX.Element | null {
  const [status, setStatus] = useState<CreditStatus | null>(peekCachedStatus());

  useEffect(() => {
    let cancelled = false;
    loadCreditStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        // surface-less — the slot is decorative; failing to fetch
        // should never block the rest of the menu.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status) return <SlotSkeleton />;

  if (status.unlimited) {
    return (
      <div className="flex flex-col gap-1 px-2 py-1.5">
        <QuotaHeader />
        <div className="text-muted-foreground pl-6 text-xs">No cap on this account</div>
      </div>
    );
  }
  if (status.limit == null || status.windowHours == null) return null;

  return (
    <div className="px-2 py-1.5">
      <QuotaProgress
        variant="slot"
        used={status.used}
        limit={status.limit}
        windowHours={status.windowHours}
        resetAt={status.resetAt}
      />
    </div>
  );
}
