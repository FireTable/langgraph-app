import { CoinsIcon } from "lucide-react";

import { cn } from "@/lib/utils";

// ponytail: shared chrome for the credit-usage surfaces. Three call
// sites render the same "icon + 'Credits' label" header:
//   1. <SlotSkeleton /> in credit-usage-slot.tsx (loading state)
//   2. the unlimited-state branch of <CreditUsageSlot />
//   3. the "slot" variant of <CreditProgress /> (limited state)
//
// Centralised so the icon and label stay in lock-step across the
// three places — the only thing that changes between them is the
// data underneath. className is forwarded so callers can add outer
// spacing (e.g. pb-1.5 for the CreditProgress variant's extra
// breathing room before the "Used X / Y" line).
export function CreditHeader({ className }: { className?: string }): React.JSX.Element {
  return (
    <div className={cn("flex items-center gap-2 text-sm font-normal", className)}>
      <CoinsIcon className="size-4 shrink-0 text-muted-foreground" />
      <span>Credits</span>
    </div>
  );
}
