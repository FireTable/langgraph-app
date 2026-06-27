"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircleIcon,
  ArrowDownIcon,
  CheckCircle2Icon,
  CoinsIcon,
  ExternalLinkIcon,
  Loader2Icon,
  WalletIcon,
  XCircleIcon,
} from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { useLangGraphSendCommand } from "@assistant-ui/react-langgraph";
import { useAccount, useSignTypedData, useSwitchChain } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { formatUnits, type Address, type Hex } from "viem";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatAmount, formatQty, parseAmount } from "@/lib/decimal";
import {
  COW_EIP712_DOMAIN,
  COW_EIP712_TYPES,
  getCowConfig,
  type CowChainId,
} from "@/lib/swap/cow-config";
import {
  defaultTargetSlug,
  resolveToken,
  tokensForChain,
  type TokenMeta,
  type TokenSlug,
} from "@/lib/tokens/catalog";
import { fetchEnrichedBalances } from "@/lib/alchemy/portfolio";
import { getNetworkLogoByChainId } from "@/lib/alchemy/networks";
import { unwrapToolResult } from "@/components/tool-ui/tool-result";

// Wallet-aware swap card. The LLM parses the user's intent (side +
// optional source / amount / target); everything else — wallet
// connection, balance enumeration, CoW quote fetching, EIP-712
// signing, /orders submission — happens in the card.
//
// Flow:
//   awaiting_user  →  fetch wagmi state
//                   →  enumerate Alchemy balances
//                   →  resolve intent into source/amount/target
//                   →  fetch CoW quote (debounced)
//                   →  render preview
//   user clicks Sign →  EIP-712 + POST /orders → addResult("signed")
//                  or  addResult("simulated_filled") for simulate mode
//   user clicks Cancel →  addResult("cancelled")
//   sign/POST fails →  addResult("error")

type Intent = {
  side: "buy" | "sell";
  source_coin_id: string | null;
  amount: number | null;
  target_coin_id: string | null;
};

type Args = {
  side: "buy" | "sell";
  source_coin_id?: string;
  amount?: number;
  target_coin_id?: string;
};

type CowQuote = {
  sellToken: Address;
  buyToken: Address;
  sellAmount: string;
  buyAmount: string;
  validTo: number;
  feeAmount: string;
  kind: "sell" | "buy";
  [k: string]: unknown;
};

type SimulatedOrder = {
  id: string;
  coin: string;
  symbol: string;
  side: "buy" | "sell";
  amount_human: number;
  qty: number;
  status: string;
  timestamp: string;
  note: string;
  slippage_bps: number;
};

type Result =
  | { status: "awaiting_user"; intent: Intent }
  | { status: "simulated_filled"; order: SimulatedOrder }
  | {
      status: "signed";
      chain_id: CowChainId;
      order_uid: `0x${string}`;
      tx_hash?: `0x${string}`;
      order?: { id: string; symbol: string; qty: number };
    }
  | { status: "cancelled" }
  | { status: "error"; error: string };

// Wallet token derived from the Portfolio API response. The address is
// null for native ETH; the slug/coinId columns are looked up against
// our internal catalog so the LLM's coin_id hints and the target-token
// dropdown still resolve cleanly. logo + priceUsd come straight from
// Portfolio and feed the row UI.
type WalletToken = {
  address: Address | null;
  symbol: string;
  decimals: number;
  balance: string; // human string, bigint-safe
  coinId: string | null;
  slug: TokenSlug | null;
  logo: string | null;
  priceUsd: number | null;
  isNative: boolean;
};

// A token the user can spend, paired with the chain it's on. The
// single Portfolio call returns tokens across all chains tagged with
// their source chain, so the UI can group them and the quote + sign
// calls know which chain to use (CoW requires same-chain settlement).
type ChainBalance = {
  chainId: CowChainId;
  token: WalletToken;
};

// Slug ↔ CoinGecko id mapping, used to match a Portfolio-listed token
// to the catalog so we can resolve a contract address to the LLM's
// coin_id hint. We do the inverse lookup by symbol because Portfolio
// doesn't return the CoinGecko id.
function coinIdForSymbol(symbol: string): string | null {
  const known: Record<string, string> = {
    USDC: "usd-coin",
    USDT: "tether",
    WETH: "ethereum",
    ETH: "ethereum",
    WBTC: "wrapped-bitcoin",
    BTC: "bitcoin",
  };
  return known[symbol.toUpperCase()] ?? null;
}

// Reverse lookup: given the LLM's coin_id, return a human symbol for
// display ("usd-coin" → "USDC"). Used by the "you don't have X" banner
// so the user sees the token they asked about, not the raw slug.
const COIN_ID_TO_SYMBOL: Record<string, string> = {
  "usd-coin": "USDC",
  tether: "USDT",
  ethereum: "WETH",
  "wrapped-bitcoin": "WBTC",
  bitcoin: "BTC",
};

function explorerUrl(chainId: number, txHash: string): string {
  switch (chainId) {
    case 1:
      return `https://etherscan.io/tx/${txHash}`;
    case 42161:
      return `https://arbiscan.io/tx/${txHash}`;
    case 8453:
      return `https://basescan.org/tx/${txHash}`;
    default:
      return `https://etherscan.io/tx/${txHash}`;
  }
}

function cowOrderUrl(orderUid: string): string {
  return `https://explorer.cow.fi/orders/${orderUid}?tab=overview`;
}

function shortUid(uid: string | undefined): string {
  if (!uid || uid.length <= 18) return uid ?? "(missing)";
  return `${uid.slice(0, 10)}…${uid.slice(-6)}`;
}

function cryptoRandomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return (crypto as Crypto).randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

function parseResult(raw: unknown): Result | { kind: "loading" } {
  const obj = unwrapToolResult<Result>(raw);
  if (!obj) return { kind: "loading" };
  return obj;
}

// --- Balance helpers --------------------------------------------------------

function slugForSymbol(symbol: string): TokenSlug | null {
  const known: Record<string, TokenSlug> = {
    USDC: "usdc",
    USDT: "usdt",
    WETH: "weth",
    WBTC: "wbtc",
  };
  return known[symbol.toUpperCase()] ?? null;
}

// Convert a hex balance string (e.g. "0x5f5e100") to a human-readable
// decimal string ("100") at the given decimals. BigInt path so we don't
// lose precision on 18-decimal wei numbers.
function formatBalanceHex(hex: string, decimals: number): string {
  let value: bigint;
  try {
    value = BigInt(hex);
  } catch {
    return "0";
  }
  if (value === BigInt(0)) return "0";
  const denom = BigInt(10) ** BigInt(decimals);
  const whole = value / denom;
  const frac = value % denom;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
}

function usdValue(token: WalletToken): number | null {
  if (token.priceUsd == null) return null;
  const num = Number(token.balance);
  if (!Number.isFinite(num)) return null;
  return num * token.priceUsd;
}

function formatUsd(n: number): string {
  if (n >= 1000) return `≈ $${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `≈ $${n.toFixed(2)}`;
  return `≈ $${n.toPrecision(2)}`;
}

// Token logo with graceful fallback: if the Portfolio-provided URL 404s
// (some tokens have stale logos), fall back to the symbol's first
// letter in a tinted circle — keeps the row layout stable. Every
// variant sits on the same `bg-muted` chip so a colored emblem
// (e.g. the blue Base square) doesn't look like a naked sticker.
function TokenLogo({ token }: { token: WalletToken }) {
  const [broken, setBroken] = useState(false);
  const letter = (token.symbol[0] ?? "?").toUpperCase();
  if (token.logo && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={token.logo}
        alt=""
        width={18}
        height={18}
        onError={() => setBroken(true)}
        className="size-[18px] shrink-0 rounded-full bg-muted p-[2px]"
      />
    );
  }
  return (
    <span className="bg-muted text-muted-foreground flex size-[18px] shrink-0 items-center justify-center rounded-full text-[10px] font-medium">
      {letter}
    </span>
  );
}

function ChainLogo({ chainId }: { chainId: number }) {
  const src = getNetworkLogoByChainId(chainId);
  if (!src) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={14}
      height={14}
      className="size-3.5 shrink-0 rounded-full bg-muted p-[1px]"
    />
  );
}

// --- CoW quote fetching ------------------------------------------------------

async function fetchCowQuote(
  chainId: CowChainId,
  sellToken: Address,
  buyToken: Address,
  amountRaw: string,
  kind: "sell" | "buy",
  from: Address,
  slippageBps: number,
  signal: AbortSignal,
): Promise<{ quote: CowQuote } | { error: string }> {
  const config = getCowConfig(chainId);
  if (!config) return { error: `chain ${chainId} not supported` };
  const body: Record<string, string | number> = {
    sellToken,
    buyToken,
    from,
    kind,
    slippageBps,
  };
  if (kind === "sell") body.sellAmountBeforeFee = amountRaw;
  else body.buyAmountAfterFee = amountRaw;
  try {
    const res = await fetch(`${config.apiUrl}/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as {
        errorType?: string;
        description?: string;
      };
      return {
        error: `cow ${res.status}${errBody.description ? `: ${errBody.description}` : ""}`,
      };
    }
    return { quote: (await res.json()) as CowQuote };
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return { error: "aborted" };
    }
    return { error: e instanceof Error ? e.message : "quote fetch failed" };
  }
}

// --- Top-level card ---------------------------------------------------------

export const CryptoConfirmCard: ToolCallMessagePartComponent<Args, Result> = ({ result, args }) => {
  const parsed = parseResult(result);
  const sendCommand = useLangGraphSendCommand();
  const { address, isConnected, chainId: wagmiChainId } = useAccount();
  const { openConnectModal } = useConnectModal();

  if ("kind" in parsed) {
    return (
      <div
        data-slot="crypto-confirm-card-loading"
        className="border-border/60 bg-card text-muted-foreground my-2 inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs"
      >
        <Loader2Icon className="size-3 animate-spin" />
        Preparing swap…
      </div>
    );
  }

  if (parsed.status === "error") {
    return (
      <div className="text-destructive my-2 inline-flex items-center gap-1.5 text-xs">
        <AlertCircleIcon className="size-3.5" />
        Order failed: {parsed.error}
      </div>
    );
  }

  if (parsed.status === "cancelled") {
    return (
      <div
        data-slot="crypto-confirm-card-cancelled"
        className="border-border/60 bg-card text-muted-foreground my-2 inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs"
      >
        <XCircleIcon className="size-3.5" /> Trade cancelled — no funds moved.
      </div>
    );
  }

  if (parsed.status === "simulated_filled") {
    return <SimulatedReceipt order={parsed.order} />;
  }

  if (parsed.status === "signed") {
    return <SignedReceipt signed={parsed} />;
  }

  // awaiting_user — preview phase. Defensive: a partial / missing intent
  // payload (LLM schema drift, truncation) would otherwise crash the
  // whole thread on first wagmi read.
  if (parsed.status === "awaiting_user") {
    if (!parsed.intent || !parsed.intent.side) {
      return (
        <div className="text-destructive my-2 inline-flex items-center gap-1.5 text-xs">
          <AlertCircleIcon className="size-3.5" />
          Swap intent was missing — please try again.
        </div>
      );
    }
    return (
      <AwaitingUserSwap
        intent={parsed.intent}
        hintArgs={args}
        isConnected={isConnected}
        address={address}
        wagmiChainId={wagmiChainId}
        onConnect={openConnectModal}
        onResolve={(payload) => sendCommand({ resume: JSON.stringify(payload) } as never)}
      />
    );
  }

  return (
    <div className="text-destructive my-2 inline-flex items-center gap-1.5 text-xs">
      <AlertCircleIcon className="size-3.5" />
      Unknown order state.
    </div>
  );
};

// --- Wallet-aware preview ----------------------------------------------------

function AwaitingUserSwap({
  intent,
  hintArgs,
  isConnected,
  address,
  wagmiChainId,
  onConnect,
  onResolve,
}: {
  intent: Intent;
  hintArgs: Args | undefined;
  isConnected: boolean;
  address: Address | undefined;
  wagmiChainId: number | undefined;
  onConnect: (() => void) | undefined;
  onResolve: (payload: unknown) => void;
}) {
  // Resolve chain. wagmi tells us which chain the user is on; CoW only
  // supports 1 / 42161 / 8453. If wagmi returns a chain we don't
  // support (e.g. Polygon), surface a structured error.
  const chainId = wagmiChainId;
  const chainConfig = chainId != null ? getCowConfig(chainId) : null;
  const chainUnsupported = wagmiChainId != null && chainConfig == null;

  // --- Wallet connection gate -----------------------------------------
  if (!isConnected) {
    return (
      <div
        data-slot="crypto-confirm-card-connect"
        className="border-border/60 bg-card text-card-foreground my-2 max-w-md overflow-hidden rounded-xl border"
      >
        <div className="flex flex-col gap-3 p-4">
          <header className="flex items-center gap-3">
            <div className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-full">
              <WalletIcon className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Authorize wallet to read your address</p>
              <p className="text-muted-foreground text-xs">
                We need your wallet address to load balances.
              </p>
            </div>
          </header>
          <Button
            type="button"
            size="sm"
            onClick={() => onConnect?.()}
            data-action="connect-wallet"
          >
            <WalletIcon className="mr-1.5 size-3.5" />
            Connect wallet
          </Button>
        </div>
      </div>
    );
  }

  if (chainUnsupported) {
    return (
      <div className="border-border/60 bg-card text-card-foreground my-2 max-w-md overflow-hidden rounded-xl border">
        <div className="flex flex-col gap-3 p-4">
          <div className="text-destructive flex items-start gap-2 text-xs">
            <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
            <span>
              Your wallet is on chain {wagmiChainId}, which isn't supported for swaps. Switch to
              Ethereum, Arbitrum, or Base and try again.
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (chainId == null || address == null) {
    // wagmi is connected but hasn't returned the chain/address yet.
    return (
      <div
        data-slot="crypto-confirm-card-loading"
        className="border-border/60 bg-card text-muted-foreground my-2 inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs"
      >
        <Loader2Icon className="size-3 animate-spin" />
        Loading wallet…
      </div>
    );
  }

  return (
    <SwapWorkspace
      intent={intent}
      hintArgs={hintArgs}
      chainId={chainId}
      address={address}
      onResolve={onResolve}
    />
  );
}

// --- Swap workspace (connected, valid chain) --------------------------------

function SwapWorkspace({
  intent,
  hintArgs,
  chainId,
  address,
  onResolve,
}: {
  intent: Intent;
  hintArgs: Args | undefined;
  chainId: CowChainId;
  address: Address;
  onResolve: (payload: unknown) => void;
}) {
  const [balances, setBalances] = useState<ChainBalance[] | null>(null);
  const [balancesError, setBalancesError] = useState<string | null>(null);
  const [balancesLoading, setBalancesLoading] = useState(true);

  // Single Portfolio API call enumerates all 3 CoW chains and bundles
  // balance + symbol + decimals + logo + USD price in one round-trip
  // (replacing the older per-chain getBalance / getTokenBalances /
  // getTokenMetadata trio).
  useEffect(() => {
    const ctrl = new AbortController();
    setBalancesLoading(true);
    setBalancesError(null);
    fetchEnrichedBalances(address, ctrl.signal)
      .then((tokens) => {
        // Portfolio API covers every L1 + L2 in the catalog; the swap
        // card can only settle on CoW chains, so non-CoW rows are
        // dropped here. The lib keeps them so other views (a future
        // portfolio widget) can use them.
        const flat: ChainBalance[] = tokens.flatMap((t) => {
          const cfg = getCowConfig(t.chainId);
          if (!cfg) return [];
          return [
            {
              chainId: t.chainId as CowChainId,
              token: {
                address: t.address,
                symbol: t.symbol,
                decimals: t.decimals,
                balance: formatBalanceHex(t.tokenBalance, t.decimals),
                coinId: coinIdForSymbol(t.symbol),
                slug: slugForSymbol(t.symbol),
                logo: t.logo,
                priceUsd: t.priceUsd,
                isNative: t.isNative,
              },
            },
          ];
        });
        setBalances(flat);
        setBalancesLoading(false);
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setBalancesError(e instanceof Error ? e.message : "balance fetch failed");
        setBalancesLoading(false);
      });
    return () => ctrl.abort();
  }, [address]);

  if (balancesLoading) {
    return (
      <CardShell title="Confirm order">
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <Loader2Icon className="size-3 animate-spin" /> Loading your balances…
        </div>
      </CardShell>
    );
  }

  if (balancesError) {
    return (
      <CardShell title="Confirm order">
        <div className="text-destructive flex items-start gap-2 text-xs">
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
          <span>Couldn't load balances: {balancesError}</span>
        </div>
      </CardShell>
    );
  }

  return (
    <SwapForm
      intent={intent}
      hintArgs={hintArgs}
      connectedChainId={chainId}
      address={address}
      balances={balances ?? []}
      onResolve={onResolve}
    />
  );
}

function CardShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      data-slot="crypto-confirm-card"
      className="border-border/60 bg-card text-card-foreground my-2 max-w-md overflow-hidden rounded-xl border"
    >
      <div className="flex flex-col gap-3 p-4">
        <header className="flex items-center gap-3">
          <div className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-full">
            <CoinsIcon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{title}</p>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}

// --- Swap form --------------------------------------------------------------

function SwapForm({
  intent,
  hintArgs,
  connectedChainId,
  address,
  balances,
  onResolve,
}: {
  intent: Intent;
  hintArgs: Args | undefined;
  connectedChainId: CowChainId;
  address: Address;
  balances: ChainBalance[];
  onResolve: (payload: unknown) => void;
}) {
  // Available tokens on each chain (from catalog). Used by the target
  // dropdown — only tokens the user can actually receive on the source's
  // chain (CoW requires same-chain settlement).
  // The dropdown is filtered to the source token's chain.
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();
  const [sourceChainId, setSourceChainId] = useState<CowChainId>(connectedChainId);

  // Available tokens on the source chain (target dropdown options).
  const sourceChainTokens = useMemo(() => tokensForChain(sourceChainId), [sourceChainId]);

  // Group balances by chain (preserving chain order). Within each chain,
  // native first, then by USD value desc — the user's gas token always
  // surfaces at the top of its chain section regardless of balance.
  const groupedByChain = useMemo(() => {
    const order = [1, 42161, 8453] as CowChainId[];
    return order
      .map((cid) => ({
        chainId: cid,
        rows: balances
          .filter((b) => b.chainId === cid)
          .sort((a, b) => {
            if (a.token.isNative !== b.token.isNative) return a.token.isNative ? -1 : 1;
            const av = usdValue(a.token);
            const bv = usdValue(b.token);
            if (av != null && bv != null) return bv - av;
            if (av != null) return -1;
            if (bv != null) return 1;
            return 0;
          }),
      }))
      .filter((g) => g.rows.length > 0);
  }, [balances]);

  // Resolve LLM hints against the user's balances + catalog.
  const initialSource = useMemo<ChainBalance | null>(() => {
    const hintId = intent.source_coin_id ?? hintArgs?.source_coin_id;
    if (hintId) {
      const match = balances.find((b) => b.token.coinId === hintId.toLowerCase());
      if (match) return match;
    }
    // No LLM hint → highest-USD-value balance, with a tie-breaker that
    // prefers the connected chain so the user doesn't have to switch.
    const ranked = [...balances].sort((a, b) => {
      const av = usdValue(a.token) ?? -1;
      const bv = usdValue(b.token) ?? -1;
      if (av !== bv) return bv - av;
      const sa = a.chainId === connectedChainId ? 1 : 0;
      const sb = b.chainId === connectedChainId ? 1 : 0;
      return sb - sa;
    });
    return ranked[0] ?? null;
  }, [intent.source_coin_id, hintArgs?.source_coin_id, balances, connectedChainId]);

  const initialTargetSlug = useMemo<TokenSlug>(() => {
    const hintId = intent.target_coin_id ?? hintArgs?.target_coin_id;
    if (hintId) {
      const tok = sourceChainTokens.find((t) => t.coinId === hintId.toLowerCase());
      if (tok) return tok.slug;
    }
    return defaultTargetSlug(initialSource?.token.slug ?? null);
  }, [intent.target_coin_id, hintArgs?.target_coin_id, sourceChainTokens, initialSource]);

  // The LLM named a specific source coin_id; if the wallet doesn't hold
  // it, surface that instead of silently substituting something else.
  // We resolve the coin_id to a human symbol via the catalog.
  const sourceHint = intent.source_coin_id ?? hintArgs?.source_coin_id;
  const hintSymbol = useMemo(() => {
    if (!sourceHint) return null;
    const sym = COIN_ID_TO_SYMBOL[sourceHint.toLowerCase()];
    if (sym) return sym;
    return sourceHint; // unknown coin — show the raw id
  }, [sourceHint]);
  const hintMissing = sourceHint != null && initialSource == null;

  const [sourcePick, setSourcePick] = useState<ChainBalance | null>(initialSource);
  const [targetSlug, setTargetSlug] = useState<TokenSlug>(initialTargetSlug);
  const sourceToken = sourcePick?.token ?? null;
  // Amount is empty unless the LLM explicitly named one — don't pre-fill
  // with the source balance. The user types the number they want to
  // trade; the "Max" link one click away fills it for them.
  const initialAmount = intent.amount ?? hintArgs?.amount ?? null;
  const [amount, setAmount] = useState<string>(
    initialAmount != null && Number.isFinite(initialAmount) ? String(initialAmount) : "",
  );
  const [slippageBps, setSlippageBps] = useState<number>(50);
  const [mode, setMode] = useState<"simulated" | "real">("simulated");
  const [submitting, setSubmitting] = useState(false);

  // Re-derive defaults if balances change (chain switch, fresh fetch).
  // Drop the source pick if its chain no longer has balances; also
  // move sourceChainId if the connected chain changes.
  useEffect(() => {
    if (balances.length > 0 && !balances.find((b) => b.chainId === sourceChainId)) {
      // Source chain has no balances — fall back to the first chain that does.
      setSourceChainId(balances[0].chainId);
    }
  }, [balances, sourceChainId]);

  useEffect(() => {
    if (
      sourcePick &&
      !balances.find(
        (b) => b.chainId === sourcePick.chainId && b.token.address === sourcePick.token.address,
      )
    ) {
      setSourcePick(initialSource);
    } else if (!sourcePick && initialSource) {
      setSourcePick(initialSource);
    }
  }, [balances, sourcePick, initialSource]);

  // Switch sourceChainId when the user picks a source on a different chain.
  useEffect(() => {
    if (sourcePick && sourcePick.chainId !== sourceChainId) {
      setSourceChainId(sourcePick.chainId);
    }
  }, [sourcePick, sourceChainId]);

  // Target must differ from source. Recompute when sourceChainId changes.
  const targetToken = useMemo<TokenMeta | null>(() => {
    const candidates = sourceChainTokens.filter((t) => t.slug !== sourceToken?.slug);
    return candidates.find((t) => t.slug === targetSlug) ?? candidates[0] ?? null;
  }, [sourceChainTokens, targetSlug, sourceToken?.slug]);

  // Quote state
  const [quote, setQuote] = useState<CowQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const quoteAbort = useRef<AbortController | null>(null);

  // Build source/buy token addresses from catalog (we know the slug,
  // the chain, so we resolve to the canonical address).
  const sourceResolved = sourceToken?.slug
    ? resolveTokenForSlug(sourceToken.slug, sourceChainId)
    : null;
  const targetResolved = targetToken ? resolveTokenForSlug(targetToken.slug, sourceChainId) : null;

  // Amount must parse + be positive.
  const amountDecimal = parseAmount(amount);
  const amountValid = amountDecimal !== null && amountDecimal.greaterThan(0);

  // Refetch quote when source / amount / target / slippage changes.
  // Debounce 400ms so typing doesn't fire on every keystroke.
  useEffect(() => {
    quoteAbort.current?.abort();
    if (!sourceResolved || !targetResolved || !amountValid) {
      setQuote(null);
      setQuoteError(null);
      setQuoteLoading(false);
      return;
    }
    const ctrl = new AbortController();
    quoteAbort.current = ctrl;
    const kind: "sell" | "buy" = intent.side; // "sell source for target" maps to kind=sell
    const amountRaw = formatAmountRaw(amountDecimal!, sourceResolved.decimals);
    setQuoteLoading(true);
    setQuoteError(null);
    const t = setTimeout(() => {
      fetchCowQuote(
        sourceChainId,
        sourceResolved.address,
        targetResolved.address,
        amountRaw,
        kind,
        address,
        slippageBps,
        ctrl.signal,
      )
        .then((r) => {
          if (ctrl.signal.aborted) return;
          if ("error" in r) {
            setQuoteError(r.error === "aborted" ? null : r.error);
            setQuote(null);
          } else {
            setQuote(r.quote);
            setQuoteError(null);
          }
          setQuoteLoading(false);
        })
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === "AbortError") return;
          setQuoteError(e instanceof Error ? e.message : "quote fetch failed");
          setQuoteLoading(false);
        });
    }, 400);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [
    intent.side,
    sourceChainId,
    sourceResolved?.address,
    sourceResolved?.decimals,
    targetResolved?.address,
    amountValid,
    amount,
    slippageBps,
    address,
  ]);

  const { signTypedDataAsync } = useSignTypedData();
  const isBusy = submitting;
  // Selected source lives on a different chain than the wallet —
  // Sign triggers switchChain first, then signs.
  const chainMismatch = sourceChainId !== connectedChainId;

  const handleSign = async () => {
    if (
      submitting ||
      !quote ||
      !sourceResolved ||
      !targetResolved ||
      !sourceToken ||
      !targetToken
    ) {
      return;
    }
    setSubmitting(true);

    const side = intent.side;
    const amountHuman = Number(amountDecimal!);
    const symbol = sourceToken.symbol;
    const targetSymbol = targetToken.symbol;
    const qty = Number(formatUnits(BigInt(quote.buyAmount), targetResolved.decimals));

    if (mode === "simulated") {
      onResolve({
        status: "simulated_filled",
        order: {
          id: `ord_${cryptoRandomId()}`,
          coin: sourceToken.coinId ?? sourceToken.slug ?? "unknown",
          symbol,
          side,
          amount_human: amountHuman,
          qty,
          status: "simulated_filled",
          timestamp: new Date().toISOString(),
          note: "Simulated fill. No on-chain transaction was sent.",
          slippage_bps: slippageBps,
        },
      });
      return;
    }

    // Real mode: switch chain if needed, then EIP-712 sign + POST.
    try {
      if (chainMismatch) {
        await switchChainAsync({ chainId: sourceChainId });
      }
      const { orderUid, txHash } = await signCowOrder({
        quote,
        chainId: sourceChainId,
        receiver: address,
        sellTokenSymbol: symbol,
        targetTokenSymbol: targetSymbol,
        targetDecimals: targetResolved.decimals,
        signTypedDataAsync: signTypedDataAsync as never,
      });
      onResolve({
        status: "signed",
        chain_id: sourceChainId,
        order_uid: orderUid,
        tx_hash: txHash,
        order: {
          id: orderUid,
          symbol: targetSymbol,
          qty,
        },
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Wallet rejected the transaction";
      onResolve({ status: "error", error: msg });
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    onResolve({ status: "cancelled" });
  };

  const handleMax = () => {
    if (!sourceToken) return;
    setAmount(sourceToken.balance);
  };

  const canSign =
    !!quote &&
    !quoteLoading &&
    !quoteError &&
    amountValid &&
    sourceResolved &&
    targetResolved &&
    !isBusy;

  return (
    <CardShell title="Confirm order">
      <div className="text-muted-foreground flex items-center gap-2 text-[11px]">
        <WalletIcon className="size-3.5 shrink-0" />
        <span>
          {address.slice(0, 6)}…{address.slice(-4)} · {chainConfigName(connectedChainId)}
        </span>
      </div>

      {/* Source token selector — balances grouped by chain. Selecting a
          token from a non-connected chain triggers switchChain on Sign. */}
      <div className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-[10px] font-medium uppercase">
          {intent.side === "sell" ? "From" : "Spend"}
        </span>
        {hintMissing ? (
          <div
            data-slot="crypto-confirm-card-hint-missing"
            className="border-border/60 bg-muted/40 text-muted-foreground flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
          >
            <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Your wallet doesn&apos;t hold{" "}
              <strong className="text-foreground">{hintSymbol}</strong>. Pick a token from your
              balances below.
            </span>
          </div>
        ) : null}
        {balances.length === 0 ? (
          <div className="text-muted-foreground text-xs">
            No balances found on Ethereum, Arbitrum, or Base.
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {groupedByChain.map(({ chainId: cid, rows }) => (
              <div key={cid} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="bg-muted/60 text-muted-foreground inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase">
                    <ChainLogo chainId={cid} />
                    {chainConfigName(cid)}
                  </span>
                  {cid === connectedChainId ? (
                    <span className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide">
                      · Connected
                    </span>
                  ) : null}
                </div>
                {rows.map((b) => {
                  const selected =
                    sourcePick?.chainId === b.chainId &&
                    sourcePick?.token.address === b.token.address;
                  const usd = usdValue(b.token);
                  return (
                    <button
                      key={`${cid}-${b.token.address ?? "native"}`}
                      type="button"
                      onClick={() => setSourcePick(b)}
                      className={cn(
                        "flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                        selected
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border/60 hover:border-border text-muted-foreground hover:text-foreground",
                      )}
                      data-action="select-source"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <TokenLogo token={b.token} />
                        <span className="font-medium">{b.token.symbol.toUpperCase()}</span>
                        {b.token.isNative ? (
                          <span className="text-muted-foreground text-[10px] uppercase">
                            (native)
                          </span>
                        ) : null}
                      </span>
                      <span className="flex shrink-0 flex-col items-end">
                        <span className="font-mono text-xs tabular-nums">{b.token.balance}</span>
                        {usd != null ? (
                          <span className="text-muted-foreground font-mono text-[10px] tabular-nums">
                            {formatUsd(usd)}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Amount input */}
      {sourceToken && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-[10px] font-medium uppercase">Amount</span>
            <button
              type="button"
              onClick={handleMax}
              aria-label="Use full balance"
              className="text-primary hover:text-primary/80 text-[10px] font-medium uppercase"
              data-action="amount-max"
            >
              Max: {sourceToken.balance.slice(0, 10)}
              {sourceToken.balance.length > 10 ? "…" : ""}
            </button>
          </div>
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            aria-invalid={amount.length > 0 && !amountValid}
            className={cn(
              "border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring flex h-9 w-full rounded-md border px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-1",
              amount.length > 0 && !amountValid && "border-destructive",
            )}
          />
        </div>
      )}

      {/* Swap arrow + target */}
      {sourceToken && (
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-center">
            <ArrowDownIcon className="text-muted-foreground size-4" />
          </div>
          <span className="text-muted-foreground text-[10px] font-medium uppercase">For</span>
          <select
            value={targetSlug}
            onChange={(e) => setTargetSlug(e.target.value as TokenSlug)}
            className="border-input bg-background focus-visible:ring-ring flex h-9 w-full rounded-md border px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-1"
          >
            {sourceChainTokens
              .filter((t) => t.slug !== sourceToken?.slug)
              .map((t) => (
                <option key={t.slug} value={t.slug}>
                  {t.symbol} — {t.name}
                </option>
              ))}
          </select>
        </div>
      )}

      {/* Quote preview */}
      {sourceToken && targetToken && (
        <div className="border-border/40 flex flex-col gap-2 rounded-md border p-2.5 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-[10px] uppercase">You pay</span>
            <span className="font-mono tabular-nums">
              {amountValid ? formatAmount(Number(amountDecimal!)) : "—"}{" "}
              <span className="text-muted-foreground">{sourceToken.symbol.toUpperCase()}</span>
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-[10px] uppercase">
              You receive {intent.side === "sell" ? "(min)" : "(max)"}
            </span>
            <span className="font-mono tabular-nums">
              {quoteLoading ? (
                <Loader2Icon className="text-muted-foreground inline size-3 animate-spin" />
              ) : quoteError ? (
                <span className="text-destructive">—</span>
              ) : quote ? (
                <>
                  {formatQty(
                    Number(formatUnits(BigInt(quote.buyAmount), targetResolved!.decimals)),
                  )}{" "}
                  <span className="text-muted-foreground">{targetToken.symbol.toUpperCase()}</span>
                </>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-[10px] uppercase">Valid until</span>
            <span className="font-mono tabular-nums">
              {quote ? new Date(quote.validTo * 1000).toLocaleTimeString() : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-[10px] uppercase">Network fee</span>
            <span className="font-mono tabular-nums">
              {quote
                ? formatQty(
                    Number(formatUnits(BigInt(quote.feeAmount || "0"), sourceResolved!.decimals)),
                  )
                : "—"}{" "}
              {quote && (
                <span className="text-muted-foreground">{sourceToken.symbol.toUpperCase()}</span>
              )}
            </span>
          </div>
          {quoteError ? (
            <div className="text-destructive flex items-start gap-1.5 text-[11px]">
              <AlertCircleIcon className="mt-0.5 size-3 shrink-0" />
              <span>{quoteError}</span>
            </div>
          ) : null}
        </div>
      )}

      {/* Slippage */}
      {sourceToken && targetToken && (
        <div className="border-border/40 flex flex-col gap-2 rounded-md border p-2.5">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-[10px] font-medium uppercase">
              Slippage tolerance
            </span>
            <span className="font-mono text-[11px] font-medium tabular-nums">
              {(slippageBps / 100).toFixed(slippageBps % 100 === 0 ? 0 : 2)}%
            </span>
          </div>
          <div className="flex gap-1">
            {[10, 50, 100, 300].map((bps) => (
              <button
                key={bps}
                type="button"
                onClick={() => setSlippageBps(bps)}
                className={cn(
                  "flex-1 rounded-sm border px-2 py-1 font-mono text-[11px] transition-colors",
                  slippageBps === bps
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border/60 text-muted-foreground hover:text-foreground",
                )}
              >
                {bps / 100}%
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Mode toggle */}
      {sourceToken && targetToken && (
        <div className="flex gap-1 rounded-md border p-0.5">
          {(["simulated", "real"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                "flex-1 rounded-sm px-3 py-1 text-xs font-medium transition-colors",
                mode === m
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m === "simulated" ? "Simulate" : "Real"}
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="flex-1"
          onClick={handleCancel}
          disabled={isBusy}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          className="flex-1"
          onClick={handleSign}
          disabled={!canSign}
          data-action="confirm-sign"
        >
          {isBusy || isSwitching ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : mode === "simulated" ? (
            `Confirm ${intent.side === "sell" ? "Sell" : "Buy"}`
          ) : chainMismatch ? (
            `Switch to ${chainConfigName(sourceChainId)} & Sign`
          ) : (
            "Sign & Place Order"
          )}
        </Button>
      </div>
    </CardShell>
  );
}

// --- CoW sign + submit ------------------------------------------------------

type SignCowOrderArgs = {
  quote: CowQuote;
  chainId: CowChainId;
  receiver: Address;
  sellTokenSymbol: string;
  targetTokenSymbol: string;
  targetDecimals: number;
  signTypedDataAsync: ReturnType<typeof useSignTypedData>["signTypedDataAsync"];
};

async function signCowOrder({
  quote,
  chainId,
  receiver,
  signTypedDataAsync,
}: SignCowOrderArgs): Promise<{ orderUid: `0x${string}`; txHash?: `0x${string}` }> {
  const config = getCowConfig(chainId);
  if (!config) throw new Error(`chain_id ${chainId} is not supported`);

  const sellAmount = BigInt(quote.sellAmount);
  const buyAmount = BigInt(quote.buyAmount);
  const feeAmount = BigInt(quote.feeAmount ?? "0");
  const orderStruct = {
    sellToken: quote.sellToken,
    buyToken: quote.buyToken,
    receiver,
    sellAmount,
    buyAmount,
    validTo: quote.validTo,
    appData: ("0x" + "0".repeat(64)) as Hex,
    feeAmount,
    kind: quote.kind,
    partiallyFillable: false,
    sellTokenBalance: "erc20" as const,
    buyTokenBalance: "erc20" as const,
  };

  const message = {
    ...orderStruct,
    sellAmount: sellAmount.toString(),
    buyAmount: buyAmount.toString(),
    feeAmount: feeAmount.toString(),
  };

  const signature = await signTypedDataAsync({
    domain: COW_EIP712_DOMAIN(chainId),
    types: COW_EIP712_TYPES,
    primaryType: "Order",
    message: message as never,
  });

  const res = await fetch(`${config.apiUrl}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      ...orderStruct,
      sellAmount: sellAmount.toString(),
      buyAmount: buyAmount.toString(),
      feeAmount: feeAmount.toString(),
      signingScheme: "eip712",
      signature,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { description?: string };
    throw new Error(`CoW /orders ${res.status}${body.description ? `: ${body.description}` : ""}`);
  }
  const json = (await res.json()) as { orderUid: `0x${string}` };
  return { orderUid: json.orderUid };
}

// --- Terminal phases --------------------------------------------------------

function SimulatedReceipt({ order }: { order: SimulatedOrder }) {
  return (
    <div
      data-slot="crypto-confirm-card-receipt"
      data-mode="simulated"
      className="border-border/60 bg-card text-card-foreground my-2 max-w-md overflow-hidden rounded-xl border"
    >
      <div className="flex flex-col gap-3 p-4">
        <header className="flex items-center gap-3">
          <div className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex size-9 shrink-0 items-center justify-center rounded-full">
            <CheckCircle2Icon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {order.side === "buy" ? "Bought" : "Sold"} {order.symbol}
            </p>
            <p className="text-muted-foreground text-xs">Simulated fill — no on-chain tx sent</p>
          </div>
          <span className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-[10px] font-medium">
            SIMULATED
          </span>
        </header>
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <dt className="text-muted-foreground text-[10px] uppercase">Paid</dt>
            <dd className="font-mono tabular-nums">
              {formatAmount(order.amount_human)} {order.symbol}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-[10px] uppercase">Filled qty</dt>
            <dd className="font-mono tabular-nums">{formatQty(order.qty)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-[10px] uppercase">Time</dt>
            <dd className="text-muted-foreground text-[11px]">
              {new Date(order.timestamp).toLocaleString()}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-[10px] uppercase">Side</dt>
            <dd className="font-mono tabular-nums capitalize">{order.side}</dd>
          </div>
        </dl>
        <footer className="border-border/60 text-muted-foreground flex flex-col gap-1 border-t pt-2 text-[10px]">
          <div className="flex items-center gap-1.5 font-mono">
            <span>order id:</span>
            <span className="truncate">{order.id}</span>
          </div>
          <div className="flex items-start gap-1.5">
            <AlertCircleIcon className="mt-0.5 size-3 shrink-0" />
            <span>{order.note}</span>
          </div>
        </footer>
      </div>
    </div>
  );
}

function SignedReceipt({ signed }: { signed: Extract<Result, { status: "signed" }> }) {
  return (
    <div
      data-slot="crypto-confirm-card-receipt"
      data-mode="real"
      className="border-border/60 bg-card text-card-foreground my-2 max-w-md overflow-hidden rounded-xl border"
    >
      <div className="flex flex-col gap-3 p-4">
        <header className="flex items-center gap-3">
          <div className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex size-9 shrink-0 items-center justify-center rounded-full">
            <CheckCircle2Icon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Order submitted to CoW</p>
            <p className="text-muted-foreground text-xs">
              Waiting for a solver to fill it (typically &lt; 1 min)
            </p>
          </div>
          <span className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 rounded-full px-2 py-0.5 text-[10px] font-medium">
            SIGNED
          </span>
        </header>
        <footer className="border-border/60 text-muted-foreground flex flex-col gap-1 border-t pt-2 text-[10px]">
          <div className="flex items-center gap-1.5 font-mono">
            <span>order:</span>
            <a
              href={cowOrderUrl(signed.order_uid)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary inline-flex items-center gap-1 hover:underline"
            >
              {shortUid(signed.order_uid)}
              <ExternalLinkIcon className="size-2.5 shrink-0" />
            </a>
          </div>
          {signed.tx_hash ? (
            <div className="flex items-center gap-1.5 font-mono">
              <span>tx:</span>
              <a
                href={explorerUrl(signed.chain_id, signed.tx_hash)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary inline-flex items-center gap-1 truncate hover:underline"
              >
                {signed.tx_hash}
                <ExternalLinkIcon className="size-2.5 shrink-0" />
              </a>
            </div>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

// --- helpers used above (kept at bottom for hoisting clarity) ---------------

function resolveTokenForSlug(
  slug: TokenSlug,
  chainId: CowChainId,
): {
  address: Address;
  decimals: number;
  coinId: string;
} | null {
  const meta = tokensForChain(chainId).find((t) => t.slug === slug);
  if (!meta) return null;
  const resolved = resolveToken(meta.coinId, chainId);
  if (!resolved) return null;
  return {
    address: resolved.address,
    decimals: resolved.meta.decimals,
    coinId: resolved.meta.coinId,
  };
}

function chainConfigName(chainId: CowChainId): string {
  return getCowConfig(chainId)?.name ?? `Chain ${chainId}`;
}

// Convert a human-string amount to a raw bigint-string. Defensive: the
// caller (lib/decimal.parseAmount) already rejects NaN / negative /
// scientific / non-numeric, so by the time we get here the string is
// "123.45"-shaped. Multiply by 10^decimals with bigint math.
function parseAmountRaw(human: string, decimals: number): string {
  const [whole, frac = ""] = human.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const negative = false; // parseAmount already rejected negatives
  const combined = `${whole}${padded}`.replace(/^0+/, "") || "0";
  return negative ? `-${combined}` : combined;
}

function formatAmountRaw(decimal: { toString(): string }, decimals: number): string {
  // lib/decimal returns a Decimal; we re-parse via parseAmountRaw's
  // string form. The decimal's toString is the canonical human form.
  return parseAmountRaw(decimal.toString(), decimals);
}
