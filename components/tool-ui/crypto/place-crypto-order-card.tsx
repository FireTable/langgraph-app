"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircleIcon,
  ArrowDownIcon,
  CheckCircle2Icon,
  CoinsIcon,
  FuelIcon,
  GaugeIcon,
  Loader2Icon,
  SparklesIcon,
  WalletIcon,
  XCircleIcon,
} from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { useLangGraphSendCommand } from "@assistant-ui/react-langgraph";

import { Button } from "@/components/ui/button";
import { AddressOrHash } from "@/components/ui/address-or-hash";
import { formatAmount, formatQty } from "@/lib/decimal";
import { cn } from "@/lib/utils";
import {
  fetchPrices,
  priceIsFallback,
  ethGasToMockCoin,
  MOCK_COIN_SYMBOL,
  MOCK_COIN_BALANCE,
} from "@/lib/prices/coingecko";
import { unwrapToolResult } from "@/components/tool-ui/tool-result";

// PlaceCryptoOrderCard — atomic simulated swap card. Hardcoded source
// is Mock Coin (the user starts with 10,000 MC — no wallet balance
// lookup, no Alchemy call). The LLM passes the user's intent as
// { target_coin_id, amount? } — the card prices the target via live
// CoinGecko, polls every 30s with a visible countdown, lets the user
// pick slippage + simulated gas tier (gas is converted to MC at the
// live ETH/USD price), and on Accept Swap synthesizes a quote — no
// real signing, no real submission. The receipt shows total MC spent
// (base + gas) so the user can see what the simulated flow "cost".

type Intent = {
  target_coin_id: string | null;
  amount: number | null;
};

type Args = {
  target_coin_id?: string;
  amount?: number;
};

type QuoteSnapshot = {
  targetUsd: number;
  targetIsFallback: boolean;
  fetchedAt: number;
};

type TargetToken = {
  coinId: string;
  symbol: string;
  name: string;
};

type SlippageBps = 10 | 50 | 100 | 300;
type GasTier = "slow" | "standard" | "fast";

type SimulatedOrder = {
  id: string;
  /** Always "mock-coin". Kept on the order so the receipt can show the source verbatim. */
  source_coin_id: string;
  target_coin_id: string;
  target_symbol: string;
  /** MC spent on the swap itself (excludes gas). */
  amount_mc: number;
  /** MC equivalent of the chosen gas tier, converted at the live ETH/USD price. */
  gas_fee_mc: number;
  /** Convenience: amount_mc + gas_fee_mc. The receipt shows this prominently. */
  total_mc: number;
  /** Target token quantity computed from amount_mc / targetUsd. */
  qty: number;
  status: string;
  timestamp: string;
  note: string;
  slippage_bps: number;
  gas_tier: GasTier;
  gas_fee_eth: number;
};

type ResumePayload =
  | { status: "simulated_filled"; order: SimulatedOrder }
  | { status: "cancelled" }
  | { status: "error"; error: string };

const POLL_INTERVAL_MS = 30_000;
const DEFAULT_AMOUNT_MC = 100;
const SLIPPAGE_PRESETS: SlippageBps[] = [10, 50, 100, 300];
const GAS_TIERS: { id: GasTier; label: string; eth: number }[] = [
  { id: "slow", label: "Slow", eth: 0.00012 },
  { id: "standard", label: "Standard", eth: 0.00018 },
  { id: "fast", label: "Fast", eth: 0.00027 },
];

function cryptoRandomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return (crypto as Crypto).randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

function symbolForCoinId(coinId: string): string {
  const known: Record<string, string> = {
    bitcoin: "BTC",
    ethereum: "ETH",
    "usd-coin": "USDC",
    tether: "USDT",
    "wrapped-bitcoin": "WBTC",
  };
  return known[coinId] ?? coinId.split("-").pop()!.toUpperCase();
}

function nameForCoinId(coinId: string): string {
  const known: Record<string, string> = {
    bitcoin: "Bitcoin",
    ethereum: "Ether",
    "usd-coin": "USD Coin",
    tether: "Tether",
    "wrapped-bitcoin": "Wrapped Bitcoin",
  };
  return known[coinId] ?? coinId;
}

function parseResult(raw: unknown): ResumePayload | null {
  return unwrapToolResult<ResumePayload>(raw);
}

export const PlaceCryptoOrderCard: ToolCallMessagePartComponent<Args> = ({ result, args }) => {
  const sendCommand = useLangGraphSendCommand();
  const parsed = parseResult(result);

  // Resolved terminal states ------------------------------------------------
  if (parsed?.status === "simulated_filled") {
    return <SimulatedReceipt order={parsed.order} />;
  }
  if (parsed?.status === "cancelled") {
    return (
      <div
        data-slot="place-crypto-order-card-cancelled"
        className="border-border/60 bg-card text-muted-foreground my-2 inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs"
      >
        <XCircleIcon className="size-3.5" /> Swap cancelled.
      </div>
    );
  }
  if (parsed?.status === "error") {
    return (
      <div
        data-slot="place-crypto-order-card-error"
        className="text-destructive my-2 inline-flex items-center gap-1.5 text-xs"
      >
        <AlertCircleIcon className="size-3.5" />
        Quote failed: {parsed.error}
      </div>
    );
  }

  return (
    <PreviewWorkspace
      intent={parseArgs(args)}
      onResolve={(payload) => sendCommand({ resume: JSON.stringify(payload) })}
    />
  );
};

function parseArgs(args: Args | undefined): Intent {
  return {
    target_coin_id: args?.target_coin_id ?? null,
    amount: args?.amount ?? null,
  };
}

// --- Preview workspace ------------------------------------------------------

function PreviewWorkspace({
  intent,
  onResolve,
}: {
  intent: Intent;
  onResolve: (payload: ResumePayload) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [quote, setQuote] = useState<QuoteSnapshot | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [slippageBps, setSlippageBps] = useState<SlippageBps>(50);
  const [gasTier, setGasTier] = useState<GasTier>("standard");

  const targetToken = useMemo<TargetToken | null>(() => {
    const coinId = intent.target_coin_id?.toLowerCase() ?? null;
    if (!coinId) return null;
    return {
      coinId,
      symbol: symbolForCoinId(coinId),
      name: nameForCoinId(coinId),
    };
  }, [intent.target_coin_id]);

  const amountMc = useMemo(() => {
    if (intent.amount != null && Number.isFinite(intent.amount) && intent.amount > 0) {
      return intent.amount;
    }
    return DEFAULT_AMOUNT_MC;
  }, [intent.amount]);

  // Live CoinGecko price ticker for the target. Polls every 30s; the
  // visible countdown ticks down to the next refresh so the user sees
  // when the "You receive" number will move next.
  //
  // Dep is targetToken only — `amountMc` belongs to the amount slider /
  // gas picker, not the price feed. Re-fetching on amount change used to
  // reset the countdown mid-tick, so the timer never reached 0 visibly.
  useEffect(() => {
    if (!targetToken) {
      setQuote(null);
      return;
    }
    const ctrl = new AbortController();
    let cancelled = false;
    const refresh = () => {
      fetchPrices([targetToken.coinId], ctrl.signal)
        .then((prices) => {
          if (cancelled || ctrl.signal.aborted) return;
          const targetUsd = prices[targetToken.coinId];
          if (targetUsd == null || targetUsd <= 0) {
            setQuoteError("Price unavailable for this coin");
            return;
          }
          setQuoteError(null);
          setQuote({
            targetUsd,
            targetIsFallback: priceIsFallback(targetToken.coinId, targetUsd),
            fetchedAt: Date.now(),
          });
        })
        .catch(() => {
          /* swallow — previous quote stays visible */
        });
    };
    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      ctrl.abort();
      clearInterval(interval);
    };
  }, [targetToken]);

  // Countdown ticker — drives the "next refresh in Ns" label.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Live gas cost in MC (recomputed each render so it tracks the live ETH price).
  const gasFeeEth = GAS_TIERS.find((g) => g.id === gasTier)!.eth;
  const gasFeeMc = useMemo(() => {
    if (!quote) return 0;
    return ethGasToMockCoin(gasFeeEth, quote.targetUsd);
  }, [quote, gasFeeEth]);

  const handleCancel = () => onResolve({ status: "cancelled" });

  if (!targetToken) {
    return (
      <CardShell>
        <div className="text-muted-foreground flex items-start gap-2 text-xs">
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
          <span>No target coin specified — name a coin (e.g. "buy 0.1 ETH") to get a quote.</span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleCancel}
          data-action="cancel-no-target"
        >
          Cancel
        </Button>
      </CardShell>
    );
  }

  const receiveSymbol = targetToken.symbol;
  const receiveQty = quote && quote.targetUsd > 0 ? amountMc / quote.targetUsd : 0;
  const canPlace = !!quote && !submitting;

  const handlePlace = () => {
    if (submitting || !quote || !targetToken) return;
    setSubmitting(true);
    const orderId = `ord_${cryptoRandomId()}`;
    const totalMc = Number((amountMc + gasFeeMc).toFixed(4));
    const order: SimulatedOrder = {
      id: orderId,
      source_coin_id: "mock-coin",
      target_coin_id: targetToken.coinId,
      target_symbol: targetToken.symbol,
      amount_mc: amountMc,
      gas_fee_mc: gasFeeMc,
      total_mc: totalMc,
      qty: receiveQty,
      status: "simulated_filled",
      timestamp: new Date().toISOString(),
      note: `Simulated swap. Spent ${amountMc} ${MOCK_COIN_SYMBOL} + ${gasFeeMc.toFixed(4)} ${MOCK_COIN_SYMBOL} gas. Nothing was signed or broadcast on-chain.`,
      slippage_bps: slippageBps,
      gas_tier: gasTier,
      gas_fee_eth: gasFeeEth,
    };
    onResolve({ status: "simulated_filled", order });
  };

  // The first render after a fetch can have `now` from before the
  // response arrived, so `now - fetchedAt` can be negative and inflate
  // the countdown to 31s. Clamp the elapsed diff at 0 so the visible
  // value never exceeds POLL_INTERVAL_MS / 1000.
  const elapsedMs = quote ? Math.max(0, now - quote.fetchedAt) : 0;
  const secondsUntilRefresh = quote
    ? Math.max(0, Math.ceil((POLL_INTERVAL_MS - elapsedMs) / 1000))
    : POLL_INTERVAL_MS / 1000;

  const refreshProgress =
    quote && POLL_INTERVAL_MS > 0
      ? Math.max(0, Math.min(1, secondsUntilRefresh / (POLL_INTERVAL_MS / 1000)))
      : 0;

  return (
    <CardShell>
      <div className="text-muted-foreground flex items-center justify-between gap-2 text-[11px]">
        <span className="flex min-w-0 items-center gap-1.5">
          <WalletIcon className="size-3.5 shrink-0" />
          <span className="font-mono tabular-nums">
            {MOCK_COIN_BALANCE.toLocaleString()} {MOCK_COIN_SYMBOL}
          </span>
        </span>
        <span className="bg-amber-500/15 text-amber-700 dark:text-amber-300 inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase">
          <SparklesIcon className="size-2.5" /> Simulated
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-[10px] font-medium uppercase">Spend</span>
        <div className="border-border/60 bg-muted/30 flex items-center justify-between rounded-md border px-3 py-2">
          <span className="font-medium text-sm">{MOCK_COIN_SYMBOL}</span>
          <span className="flex flex-col items-end">
            <span className="font-mono text-xs tabular-nums">{formatAmount(amountMc)}</span>
            <span className="text-muted-foreground text-[10px] uppercase tabular-nums">
              of {MOCK_COIN_BALANCE.toLocaleString()} held
            </span>
          </span>
        </div>
      </div>

      <div className="flex justify-center">
        <ArrowDownIcon className="text-muted-foreground size-4" />
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-[10px] font-medium uppercase">For</span>
        <div className="border-border/60 bg-muted/30 flex items-center justify-between rounded-md border px-3 py-2">
          <span className="font-medium text-sm">{receiveSymbol}</span>
          <span className="text-muted-foreground text-[10px] uppercase">simulated</span>
        </div>
      </div>

      <div className="border-border/40 flex flex-col gap-2 rounded-md border p-2.5 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground text-[10px] uppercase">You pay</span>
          <span className="font-mono tabular-nums">
            {formatAmount(amountMc)}{" "}
            <span className="text-muted-foreground">{MOCK_COIN_SYMBOL}</span>
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground text-[10px] uppercase">You receive (est)</span>
          <span className="font-mono tabular-nums">
            {quote ? (
              <>
                {formatQty(receiveQty)}{" "}
                <span className="text-muted-foreground">{receiveSymbol}</span>
              </>
            ) : (
              <Loader2Icon className="text-muted-foreground inline size-3 animate-spin" />
            )}
          </span>
        </div>
        {quote ? (
          <div className="text-muted-foreground text-[10px]">
            <span>
              1 {receiveSymbol} ≈ ${quote.targetUsd.toLocaleString()}
              {quote.targetIsFallback ? " (fallback)" : ""}
            </span>
          </div>
        ) : quoteError ? (
          <div className="text-destructive flex items-center gap-1 text-[10px]">
            <AlertCircleIcon className="size-3" /> {quoteError}
          </div>
        ) : null}
      </div>

      <div className="border-border/40 flex flex-col gap-2 rounded-md border p-2.5">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground flex items-center gap-1.5 text-[10px] font-medium uppercase">
            <GaugeIcon className="size-3" /> Slippage
          </span>
          <span className="font-mono text-xs tabular-nums">{(slippageBps / 100).toFixed(2)}%</span>
        </div>
        <div className="flex gap-1">
          {SLIPPAGE_PRESETS.map((bps) => (
            <button
              key={bps}
              type="button"
              onClick={() => setSlippageBps(bps)}
              className={cn(
                "border-border/60 hover:bg-muted/60 flex-1 rounded-md border px-2 py-1 font-mono text-xs tabular-nums transition-colors",
                slippageBps === bps && "border-primary/40 bg-primary/10 text-primary font-medium",
              )}
              data-action={`slippage-${bps}`}
            >
              {(bps / 100).toFixed(bps < 100 ? 1 : 0)}%
            </button>
          ))}
        </div>
      </div>

      <div className="border-border/40 flex flex-col gap-2 rounded-md border p-2.5">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground flex items-center gap-1.5 text-[10px] font-medium uppercase">
            <FuelIcon className="size-3" /> Simulated Gas
          </span>
          <span className="font-mono text-xs tabular-nums">
            {quote ? `${gasFeeMc.toFixed(4)} ${MOCK_COIN_SYMBOL}` : `${gasFeeEth} ETH`}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-1">
          {GAS_TIERS.map((tier) => (
            <button
              key={tier.id}
              type="button"
              onClick={() => setGasTier(tier.id)}
              className={cn(
                "border-border/60 hover:bg-muted/60 flex flex-col items-center gap-0.5 rounded-md border px-2 py-1.5 transition-colors",
                gasTier === tier.id && "border-primary/40 bg-primary/10 text-primary",
              )}
              data-action={`gas-${tier.id}`}
            >
              <span className="text-[11px] font-medium">{tier.label}</span>
              <span className="text-muted-foreground font-mono text-[10px] tabular-nums">
                {tier.eth} ETH
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="border-border/40 flex items-center justify-between rounded-md border p-2.5 text-sm">
        <span className="text-muted-foreground text-[10px] font-medium uppercase">Total spent</span>
        <span className="font-mono text-sm font-semibold tabular-nums">
          {quote
            ? `${(amountMc + gasFeeMc).toFixed(4)} ${MOCK_COIN_SYMBOL}`
            : `${amountMc} ${MOCK_COIN_SYMBOL}`}
        </span>
      </div>

      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="flex-1"
          onClick={handleCancel}
          disabled={submitting}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          className="relative flex-1 overflow-hidden"
          onClick={handlePlace}
          disabled={!canPlace}
          data-action="place-simulated-order"
        >
          {submitting ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <span
              className="flex w-full items-center justify-center gap-2 transition-opacity duration-1000 ease-linear"
            >
              <span>Accept Swap</span>
              {quote && (
                <span className="font-mono text-[10px] tabular-nums">
                  · {secondsUntilRefresh}s
                </span>
              )}
            </span>
          )}
          {/* Right-to-left drain bar. Anchored to the button's right
              edge; transform-origin: right keeps the right edge fixed
              while scaleX shrinks the bar from the left. Uses transform
              (not width) so the per-second tick only triggers a
              compositor repaint — no layout / no reflow. */}
          {quote && !submitting && (
            <span
              aria-hidden
              className="bg-primary-foreground/50 absolute right-0 bottom-0 h-1 w-full origin-right transition-transform duration-1000 ease-linear"
              style={{ transform: `scaleX(${refreshProgress})` }}
            />
          )}
        </Button>
      </div>
    </CardShell>
  );
}

// --- Shell + receipt --------------------------------------------------------

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-slot="place-crypto-order-card"
      className="border-border/60 bg-card text-card-foreground my-2 max-w-md overflow-hidden rounded-xl border"
    >
      <div className="flex flex-col gap-3 p-4">
        <header className="flex items-center gap-3">
          <div className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-full">
            <CoinsIcon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Swap Quote</p>
            <p className="text-muted-foreground text-xs">
              Prices are live; nothing will be signed or sent.
            </p>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}

function SimulatedReceipt({ order }: { order: SimulatedOrder }) {
  return (
    <div
      data-slot="place-crypto-order-card-receipt"
      className="border-border/60 bg-card text-card-foreground my-2 max-w-md overflow-hidden rounded-xl border"
    >
      <div className="flex flex-col gap-3 p-4">
        <header className="flex items-center gap-3">
          <div className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex size-9 shrink-0 items-center justify-center rounded-full">
            <CheckCircle2Icon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Swap Accepted</p>
            <p className="text-muted-foreground text-xs">Nothing was signed or broadcast.</p>
          </div>
          <span className="bg-amber-500/15 text-amber-700 dark:text-amber-300 rounded-full px-2 py-0.5 text-[10px] font-medium">
            SIMULATED
          </span>
        </header>
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <dt className="text-muted-foreground text-[10px] uppercase">You paid</dt>
            <dd className="font-mono tabular-nums">
              {formatAmount(order.amount_mc)} {MOCK_COIN_SYMBOL}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-[10px] uppercase">You would receive</dt>
            <dd className="font-mono tabular-nums">
              {formatQty(order.qty)} {order.target_symbol}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-[10px] uppercase">Simulated gas</dt>
            <dd className="font-mono tabular-nums">
              {order.gas_fee_mc.toFixed(4)} {MOCK_COIN_SYMBOL}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-[10px] uppercase">Total spent</dt>
            <dd className="font-mono text-sm font-semibold tabular-nums">
              {order.total_mc.toFixed(4)} {MOCK_COIN_SYMBOL}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-[10px] uppercase">Slippage</dt>
            <dd className="font-mono tabular-nums">{(order.slippage_bps / 100).toFixed(2)}%</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-[10px] uppercase">Time</dt>
            <dd className="text-muted-foreground text-[11px]">
              {new Date(order.timestamp).toLocaleString()}
            </dd>
          </div>
          <div className="col-span-2">
            <dt className="text-muted-foreground text-[10px] uppercase">Quote id</dt>
            <dd>
              <AddressOrHash value={order.id} head={10} tail={6} />
            </dd>
          </div>
        </dl>
      </div>
      <footer className="border-border/60 text-muted-foreground flex items-start gap-1.5 border-t px-4 py-2.5 text-[10px]">
        <AlertCircleIcon className="mt-0.5 size-3 shrink-0" />
        <span>{order.note}</span>
      </footer>
    </div>
  );
}
