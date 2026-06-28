"use client";

import { useState } from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ClockIcon,
  CoinsIcon,
  Loader2Icon,
  XCircleIcon,
} from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { useLangGraphSendCommand } from "@assistant-ui/react-langgraph";

import { Button } from "@/components/ui/button";
import { AddressOrHash } from "@/components/ui/address-or-hash";
import { cn } from "@/lib/utils";
import { unwrapToolResult } from "@/components/tool-ui/tool-result";

// OrderStatusCard — atomic status-check card. Reads the order_uid +
// chain_id passed by the LLM, displays them, and on user click
// synthesizes a status (this is a simulated-order demo — the real CoW
// /orders/{uid} endpoint can't find the synthetic uid from
// place_crypto_order). The synthesized status flows back to the LLM.

type Args = {
  order_uid: string;
  chain_id: number;
};

type ResumePayload = {
  status: "filled" | "open" | "partially_filled" | "cancelled" | "expired" | "not_found";
  order_uid: string;
  chain_id: number;
  filled_buy_amount?: string;
  executed_at?: string;
};

function chainName(chainId: number): string {
  switch (chainId) {
    case 1:
      return "Ethereum";
    case 42161:
      return "Arbitrum One";
    case 8453:
      return "Base";
    case 11155111:
      return "Sepolia";
    default:
      return `Chain ${chainId}`;
  }
}

function parseResult(raw: unknown): ResumePayload | null {
  return unwrapToolResult<ResumePayload>(raw);
}

export const OrderStatusCard: ToolCallMessagePartComponent<Args> = ({ result, args }) => {
  const sendCommand = useLangGraphSendCommand();
  const [checking, setChecking] = useState(false);

  const orderUid = args?.order_uid ?? "";
  const chainId = args?.chain_id ?? 0;
  const parsed = parseResult(result);

  // Resolved terminal states.
  if (parsed) {
    return <StatusReceipt status={parsed} />;
  }

  // Interactive state — show the uid + a Check button.
  const handleCheck = () => {
    setChecking(true);
    // Synthetic status — the order came from place_crypto_order, which
    // never actually submits to CoW. For demo purposes, deterministically
    // fill it (matches the "place then check" narrative).
    const payload: ResumePayload = {
      status: "filled",
      order_uid: orderUid,
      chain_id: chainId,
      filled_buy_amount: "0",
      executed_at: new Date().toISOString(),
    };
    sendCommand({ resume: JSON.stringify(payload) });
  };

  return (
    <div
      data-slot="order-status-card"
      className="border-border/60 bg-card text-card-foreground my-2 max-w-md overflow-hidden rounded-xl border"
    >
      <div className="flex flex-col gap-3 p-4">
        <header className="flex items-center gap-3">
          <div className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-full">
            <CoinsIcon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Swap Status</p>
            <p className="text-muted-foreground text-xs">{chainName(chainId)} · simulated</p>
          </div>
        </header>

        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div className="col-span-2">
            <dt className="text-muted-foreground text-[10px] uppercase">Quote id</dt>
            <dd className="mt-0.5">
              <AddressOrHash value={orderUid} head={10} tail={6} />
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-[10px] uppercase">Chain</dt>
            <dd className="font-mono text-[11px] tabular-nums">{chainName(chainId)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-[10px] uppercase">Status</dt>
            <dd className="text-muted-foreground inline-flex items-center gap-1 text-[11px]">
              <ClockIcon className="size-3" /> pending check
            </dd>
          </div>
        </dl>

        <Button
          type="button"
          size="sm"
          onClick={handleCheck}
          disabled={checking || !orderUid}
          data-action="check-order-status"
        >
          {checking ? <Loader2Icon className="size-4 animate-spin" /> : "Check status"}
        </Button>
      </div>
    </div>
  );
};

function StatusReceipt({ status }: { status: ResumePayload }) {
  const isFilled = status.status === "filled";
  const isOpen = status.status === "open" || status.status === "partially_filled";
  const isCancelled = status.status === "cancelled" || status.status === "expired";
  const isMissing = status.status === "not_found";

  return (
    <div
      data-slot="order-status-card-resolved"
      className="border-border/60 bg-card text-card-foreground my-2 max-w-md overflow-hidden rounded-xl border"
    >
      <div className="flex flex-col gap-3 p-4">
        <header className="flex items-center gap-3">
          <div
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-full",
              isFilled && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
              isOpen && "bg-amber-500/10 text-amber-600 dark:text-amber-400",
              (isCancelled || isMissing) && "bg-muted text-muted-foreground",
            )}
          >
            {isFilled ? (
              <CheckCircle2Icon className="size-4" />
            ) : isOpen ? (
              <ClockIcon className="size-4" />
            ) : (
              <XCircleIcon className="size-4" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {isFilled
                ? "Quote Accepted"
                : isOpen
                  ? "Quote Pending"
                  : isMissing
                    ? "Quote Not Found"
                    : "Quote Closed"}
            </p>
            <p className="text-muted-foreground text-xs">
              {chainName(status.chain_id)} · simulated
            </p>
          </div>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase",
              isFilled && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
              isOpen && "bg-amber-500/15 text-amber-700 dark:text-amber-300",
              (isCancelled || isMissing) && "bg-muted text-muted-foreground",
            )}
          >
            {status.status}
          </span>
        </header>

        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-muted-foreground text-[10px] uppercase">Quote id</dt>
            <dd className="mt-0.5">
              <AddressOrHash value={status.order_uid} head={10} tail={6} />
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-[10px] uppercase">Filled qty</dt>
            <dd className="font-mono tabular-nums">
              {status.filled_buy_amount && status.filled_buy_amount !== "0"
                ? status.filled_buy_amount
                : "—"}
            </dd>
          </div>
          <div className="col-span-2">
            <dt className="text-muted-foreground text-[10px] uppercase">Executed at</dt>
            <dd className="text-muted-foreground text-[11px]">
              {status.executed_at ? new Date(status.executed_at).toLocaleString() : "—"}
            </dd>
          </div>
        </dl>
      </div>
      <footer className="border-border/60 text-muted-foreground flex items-start gap-1.5 border-t px-4 py-2.5 text-[10px]">
        <AlertCircleIcon className="mt-0.5 size-3 shrink-0" />
        <span>Simulated status. The uid is a placeholder — nothing was broadcast on-chain.</span>
      </footer>
    </div>
  );
}
