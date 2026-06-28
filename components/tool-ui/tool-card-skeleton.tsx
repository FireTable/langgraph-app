"use client";

import { Loader2Icon } from "lucide-react";

// Shared loading placeholder for tool-call parts. Inline row so it
// doesn't try to mimic any specific card's size — the actual card
// (weather widget, price list, …) takes whatever shape it needs when
// it lands.
export function ToolCardSkeleton({ label }: { label: string }) {
  return (
    <div
      data-slot="tool-card-skeleton"
      className="text-muted-foreground inline-flex items-center gap-2 text-xs"
    >
      <Loader2Icon className="size-4 animate-spin" />
      <span>{label}</span>
    </div>
  );
}
