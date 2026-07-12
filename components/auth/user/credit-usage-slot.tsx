"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { QuotaHeader } from "@/components/credit/quota-header";
import { QuotaProgress } from "@/components/credit/quota-progress";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { loadCreditStatus, peekCachedStatus, type CreditStatus } from "@/lib/credit/status";

const SETTINGS_CREDIT_PATH = "/settings/credit";

// ponytail: read-only credit-usage indicator rendered inside the
// UserButton dropdown between the user header and the link list.
// Hits /api/credit/status (the same path the proxy uses for its
// quota gate) so the number on the surface and the gate that
// blocks the chat stay in lock-step — a single source of truth
// for "how much have I used". The cache + in-flight promise live
// in lib/credit/status.ts so the UserButton slot and the settings
// page summary card share one network round-trip when both are
// mounted at once (desktop sidebar + settings tab open).
//
// The data-bearing branches wrap their content in <DropdownMenuItem
// asChild onSelect={...}> so a click (or Enter/Space while focused)
// navigates to /settings/credit AND closes the menu in one motion —
// the alternative (plain button) leaves the dropdown open over the
// new page because Radix only auto-closes on DropdownMenuItem's
// onSelect, not on arbitrary child clicks. The Skeleton branch is
// not interactive — there's nothing to navigate to while loading.
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

function SlotBody({
  onSelect,
  children,
}: {
  onSelect: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  // ponytail: shared interactive wrapper. asChild merges Radix's
  // onSelect (and its menu-close behaviour) onto the child div so
  // hover/focus styling lands directly on the slot content instead
  // of an extra ring around it. hover:bg-accent/40 + focus:bg-accent
  // matches the affordance other DropdownMenuItems give the user,
  // with a lighter hover so it reads as "preview" rather than
  // "selected".
  return (
    <DropdownMenuItem asChild onSelect={onSelect}>
      <div className="hover:bg-accent/40 focus:bg-accent cursor-pointer rounded-md px-2 py-1.5 outline-hidden transition-colors">
        {children}
      </div>
    </DropdownMenuItem>
  );
}

export function CreditUsageSlot(): React.JSX.Element | null {
  const router = useRouter();
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

  const navigateToCredit = () => router.push(SETTINGS_CREDIT_PATH);

  if (status.unlimited) {
    return (
      <SlotBody onSelect={navigateToCredit}>
        <div className="flex flex-col gap-1">
          <QuotaHeader />
          <div className="text-muted-foreground pl-6 text-xs">No cap on this account</div>
        </div>
      </SlotBody>
    );
  }
  if (status.limit == null || status.windowHours == null) return null;

  return (
    <SlotBody onSelect={navigateToCredit}>
      <QuotaProgress
        variant="slot"
        used={status.used}
        limit={status.limit}
        windowHours={status.windowHours}
        resetAt={status.resetAt}
      />
    </SlotBody>
  );
}