"use client";

import { Loader2Icon } from "lucide-react";
import { cn } from "@/lib/utils";

// Shared loading placeholder for tool-call parts. Sized to match the
// WeatherWidget so the layout doesn't jump when the result lands.
export function ToolCardSkeleton({ label }: { label: string }) {
  return (
    <div
      data-slot="tool-card-skeleton"
      className={cn(
        "bg-card/60 border-border/60 text-muted-foreground flex aspect-4/3 w-full max-w-md flex-col items-center justify-center gap-2 rounded-2xl border backdrop-blur",
      )}
    >
      <Loader2Icon className="size-5 animate-spin" />
      <span className="text-xs">{label}</span>
    </div>
  );
}
