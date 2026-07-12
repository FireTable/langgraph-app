"use client";

import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { CoinsIcon } from "lucide-react";
import { CreditProgress } from "@/components/credit/credit-progress";
import { CardHeader, CardShell } from "@/components/tool-ui/primitives/card";

// ponytail: the proxy injects the full messages array (no ToolMessage
// follows) when the credit cap blocks the turn, so the args ride on
// the tool call itself — `result` stays undefined and the card reads
// everything from `args`. Model-driven cards (save_memory etc.) parse
// `result` instead because LangGraph's ToolNode writes the ToolMessage.
type Args = {
  resetAt: string;
  limit: number;
  used: number;
  windowHours: number;
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export const CreditCard: ToolCallMessagePartComponent<Args> = ({ args }) => {
  const resetAt = typeof args?.resetAt === "string" ? args.resetAt : "";
  const limit = typeof args?.limit === "number" ? args.limit : 0;
  const used = typeof args?.used === "number" ? args.used : 0;
  const windowHours = typeof args?.windowHours === "number" ? args.windowHours : 0;

  const subtitle = resetAt
    ? `Resets at ${formatTime(resetAt)}`
    : "Resets when the oldest in-window call ages out";

  return (
    <CardShell data-slot="show-credit-card" maxWidthClass="max-w-md">
      <CardHeader
        icon={<CoinsIcon className="size-4" />}
        iconClassName="bg-amber-500/10 text-amber-500"
        title="Credit limit reached"
        subtitle={subtitle}
      />
      <CreditProgress
        variant="card"
        used={used}
        limit={limit}
        windowHours={windowHours}
        resetAt={resetAt}
      />
    </CardShell>
  );
};
