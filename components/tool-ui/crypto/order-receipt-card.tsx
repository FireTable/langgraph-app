"use client";

import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { CheckCircle2Icon, InfoIcon, WalletIcon } from "lucide-react";

import { ToolCardSkeleton } from "@/components/tool-ui/tool-card-skeleton";
import { unwrapToolResult } from "@/components/tool-ui/tool-result";
import { cn } from "@/lib/utils";

type Order = {
  id: string;
  coin: string;
  symbol: string;
  side: "buy" | "sell";
  amount_usd: number;
  qty: number;
  price_at_confirm: number;
  status: string;
  timestamp: string;
  note: string;
};

type Result = { success: true; order: Order } | { success: false; error: string };

type Args = {
  coin_id: string;
  coin_symbol: string;
  amount_usd: number;
  price_at_confirm: number;
  side: "buy" | "sell";
};

function parse(raw: unknown) {
  const obj = unwrapToolResult<Result>(raw);
  if (!obj) return { kind: "loading" as const };
  if (obj.success === true) return { kind: "ok" as const, order: obj.order };
  if (obj.success === false) return { kind: "error" as const, message: obj.error };
  return { kind: "loading" as const };
}

function formatUsd(n: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);
}

function formatQty(n: number) {
  return n.toFixed(n < 1 ? 6 : 4);
}

function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export const CryptoOrderReceiptCard: ToolCallMessagePartComponent<Args, Result> = ({
  result,
  args,
}) => {
  const parsed = parse(result);

  if (parsed.kind === "loading") {
    return <ToolCardSkeleton label="Confirming order…" />;
  }
  if (parsed.kind === "error") {
    return <div className="text-destructive my-2 text-xs">Order failed: {parsed.message}</div>;
  }

  const o = parsed.order;
  return (
    <div
      data-slot="crypto-order-receipt-card"
      className="border-border/60 bg-card text-card-foreground my-2 max-w-md overflow-hidden rounded-xl border"
    >
      <div className="flex flex-col gap-3 p-4">
        <header className="flex items-center gap-3">
          <div
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-full",
              o.side === "buy"
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "bg-rose-500/10 text-rose-600 dark:text-rose-400",
            )}
          >
            <CheckCircle2Icon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {o.side === "buy" ? "Bought" : "Sold"} {o.symbol}
            </p>
            <p className="text-muted-foreground text-xs">Simulated fill — no on-chain tx sent</p>
          </div>
          <span className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-[10px] font-medium">
            SIMULATED
          </span>
        </header>

        <dl className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <dt className="text-muted-foreground text-[10px] uppercase">Quantity</dt>
            <dd className="font-mono tabular-nums">
              {formatQty(o.qty)} {o.symbol}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-[10px] uppercase">Price</dt>
            <dd className="font-mono tabular-nums">{formatUsd(o.price_at_confirm)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-[10px] uppercase">Total</dt>
            <dd className="font-mono font-semibold tabular-nums">{formatUsd(o.amount_usd)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-[10px] uppercase">Time</dt>
            <dd className="text-muted-foreground text-[11px]">{formatTime(o.timestamp)}</dd>
          </div>
        </dl>

        <footer className="border-border/60 text-muted-foreground flex flex-col gap-1 border-t pt-2 text-[10px]">
          <div className="flex items-center gap-1.5 font-mono">
            <span>order id:</span>
            <span className="truncate">{o.id}</span>
          </div>
          <div className="flex items-start gap-1.5">
            <InfoIcon className="mt-0.5 size-3 shrink-0" />
            <span>{o.note}</span>
          </div>
          {args ? (
            <div className="text-muted-foreground/70 flex items-center gap-1.5">
              <WalletIcon className="size-3 shrink-0" />
              <span>
                Connect a wallet + mainnet to enable real swaps (disabled in simulated mode).
              </span>
            </div>
          ) : null}
        </footer>
      </div>
    </div>
  );
};
