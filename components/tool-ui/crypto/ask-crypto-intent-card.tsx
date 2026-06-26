"use client";

import { useEffect, useState } from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CoinsIcon,
  Loader2Icon,
  WalletIcon,
} from "lucide-react";
import { formatUnits } from "viem";
import { useAccount, useBalance } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useLangGraphSendCommand } from "@assistant-ui/react-langgraph";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";

import { Button } from "@/components/ui/button";
import { unwrapToolResult } from "@/components/tool-ui/tool-result";
import { cn } from "@/lib/utils";
import { formatAmount, parseAmount } from "@/lib/decimal";

// Tool result the user picks from the card. Mirrors the backend tool's
// resume payload (backend/tool/crypto/ask-crypto-intent.ts).
//   { coin_id, coin_symbol, amount, currency, side } — user confirmed
//   { error }                                        — user cancelled
// The LLM detects the currency from the message and passes it through
// `args.currency`; the card lets the user confirm or change the amount
// in that currency, then the LLM converts to USD before confirm_crypto_order.
export type AskCryptoIntentResult =
  | {
      coin_id: string;
      coin_symbol: string;
      amount: number;
      currency: string;
      side: "buy" | "sell";
    }
  | { error: string };

// Tool call args the LLM fills when invoking ask_crypto_intent. The card
// reads currency (required, defaults to USD) and amount (optional pre-fill).
type AskCryptoIntentArgs = {
  message?: string;
  currency?: string;
  amount?: number;
};

// Hardcoded list of coins the card can resolve. CoinGecko ids are stable;
// mapping ticker → id is the only piece the LLM has to be careful about.
// Upgrade path: pull this from CoinGecko's /coins/list when we add a search box.
const COIN_OPTIONS = [
  { coin_id: "bitcoin", symbol: "BTC", name: "Bitcoin" },
  { coin_id: "ethereum", symbol: "ETH", name: "Ethereum" },
  { coin_id: "solana", symbol: "SOL", name: "Solana" },
  { coin_id: "binancecoin", symbol: "BNB", name: "BNB" },
  { coin_id: "dogecoin", symbol: "DOGE", name: "Dogecoin" },
  { coin_id: "usd-coin", symbol: "USDC", name: "USD Coin" },
] as const;

type Mode = "idle" | "submitting";

export const AskCryptoIntentCard: ToolCallMessagePartComponent<AskCryptoIntentArgs> = ({
  result,
  args,
}) => {
  const parsed = unwrapToolResult<AskCryptoIntentResult>(result);
  const sendCommand = useLangGraphSendCommand();
  const { address, isConnected } = useAccount();
  const { data: balance } = useBalance({ address });
  const { openConnectModal } = useConnectModal();

  // LLM detected currency from the message; default to USD if missing.
  const currency = (args?.currency ?? "USD").toUpperCase();
  const [coinId, setCoinId] = useState<string>(COIN_OPTIONS[0].coin_id);
  const [amount, setAmount] = useState<string>(args?.amount != null ? String(args.amount) : "100");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [mode, setMode] = useState<Mode>("idle");
  // Wallet connection is part of the order flow. If the user clicks
  // Confirm without a connected wallet, we open RainbowKit's modal and
  // queue the resume until they connect. `pendingResume` captures the
  // current form so the effect below can re-emit it once isConnected
  // flips (RainbowKit's modal calls wagmi's connect() under the hood
  // and closes itself on success).
  const [pendingResume, setPendingResume] = useState<AskCryptoIntentResult | null>(null);

  const coin = COIN_OPTIONS.find((c) => c.coin_id === coinId) ?? COIN_OPTIONS[0];
  // Decimal-validated amount. null = invalid (empty, negative, scientific,
  // non-numeric, or over the safety cap). See lib/decimal for the rules.
  const amountDecimal = parseAmount(amount);
  const isValid = amountDecimal !== null;

  const resume = (payload: AskCryptoIntentResult) => {
    sendCommand({ resume: JSON.stringify(payload) });
  };

  const buildResume = (): AskCryptoIntentResult => ({
    coin_id: coin.coin_id,
    coin_symbol: coin.symbol,
    // .toNumber() is safe here — parseAmount already enforced the safety
    // cap (≤ 1e15), well under Number.MAX_SAFE_INTEGER (~9e15).
    amount: amountDecimal!.toNumber(),
    currency,
    side,
  });

  const handleConfirm = () => {
    if (!isValid) return;
    if (!isConnected) {
      // Queue the resume; the effect below flushes it once isConnected
      // flips. openConnectModal is undefined when RainbowKitProvider
      // isn't mounted (e.g. unit tests) — fall back to a no-op rather
      // than throwing.
      setPendingResume(buildResume());
      openConnectModal?.();
      return;
    }
    setMode("submitting");
    resume(buildResume());
  };

  // Flush queued resume once the wallet connects. Depends only on
  // isConnected + pendingResume (sendCommand is intentionally omitted
  // — it comes from a hook and is stable enough for our purposes).
  useEffect(() => {
    if (isConnected && pendingResume) {
      setMode("submitting");
      resume(pendingResume);
      setPendingResume(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, pendingResume]);

  const handleCancel = () => {
    setMode("submitting");
    resume({ error: "User cancelled" });
  };

  return (
    <div
      data-slot="ask-crypto-intent-card"
      className="border-border/60 bg-card text-card-foreground my-2 max-w-md overflow-hidden rounded-xl border"
    >
      <div className="flex flex-col gap-3 p-4">
        <header className="flex items-center gap-3">
          <div className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-full">
            <CoinsIcon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Place a simulated trade</p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {parsed && "coin_id" in parsed
                ? "Sent to the assistant."
                : "Pick a coin and amount. No on-chain transaction is sent."}
            </p>
          </div>
        </header>

        {/* Resolved: show the chosen pick as a confirmation, no more actions. */}
        {parsed && "coin_id" in parsed && (
          <div className="border-border/60 bg-muted/40 text-foreground flex items-center gap-3 rounded-lg border px-3 py-2.5">
            <CheckCircle2Icon className="text-primary size-5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {parsed.side === "buy" ? "Buy" : "Sell"} {parsed.coin_symbol}
              </p>
              <p className="text-muted-foreground mt-0.5 font-mono text-[11px]">
                {formatAmount(parsed.amount)} {parsed.currency} notional
              </p>
            </div>
          </div>
        )}

        {parsed && "error" in parsed && (
          <div className="text-destructive-foreground border-destructive/40 bg-destructive/10 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
            <AlertCircleIcon className="text-destructive mt-0.5 size-4 shrink-0" />
            <span className="text-destructive/90">{parsed.error}</span>
          </div>
        )}

        {/* Interactive: only when user hasn't decided yet. */}
        {!parsed && (
          <div className="flex flex-col gap-3">
            <div className="flex gap-1 rounded-md border p-0.5">
              {(["buy", "sell"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSide(s)}
                  className={cn(
                    "flex-1 rounded-sm px-3 py-1.5 text-xs font-medium capitalize transition-colors",
                    side === s
                      ? s === "buy"
                        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                        : "bg-rose-500/15 text-rose-700 dark:text-rose-300"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {s}
                </button>
              ))}
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-[10px] font-medium uppercase">Coin</span>
              <select
                value={coinId}
                onChange={(e) => setCoinId(e.target.value)}
                className="border-input bg-background focus-visible:ring-ring flex h-9 w-full rounded-md border px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-1"
              >
                {COIN_OPTIONS.map((c) => (
                  <option key={c.coin_id} value={c.coin_id}>
                    {c.symbol} — {c.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-[10px] font-medium uppercase">
                Amount ({currency})
              </span>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-invalid={amount.length > 0 && !isValid}
                className={cn(
                  "border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring flex h-9 w-full rounded-md border px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-1",
                  amount.length > 0 && !isValid && "border-destructive",
                )}
                placeholder="100"
              />
            </label>

            {/* Wallet status — only shows the connected address. The order
                button handles the "not connected" case by opening the picker. */}
            {isConnected && address ? (
              <div className="text-muted-foreground flex items-center gap-2 text-[11px]">
                <WalletIcon className="size-3.5 shrink-0" />
                <span>
                  {address.slice(0, 6)}…{address.slice(-4)}
                  {balance
                    ? ` · ${formatUnits(balance.value, balance.decimals)} ${balance.symbol}`
                    : ""}
                </span>
              </div>
            ) : null}

            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={handleCancel}
                disabled={mode === "submitting"}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                className="flex-1"
                onClick={handleConfirm}
                disabled={!isValid || mode === "submitting"}
              >
                {mode === "submitting" ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : isConnected ? (
                  <>
                    Confirm {side} {coin.symbol}
                  </>
                ) : (
                  <>
                    <WalletIcon className="mr-1.5 size-3.5" />
                    Connect & {side} {coin.symbol}
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
