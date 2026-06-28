import type { Address } from "viem";

import {
  ALCHEMY_NETWORK_CATALOG,
  getNetworkLogoByChainId,
  type AlchemyNetworkSlug,
} from "@/lib/alchemy/networks";

// Alchemy Portfolio API — single-call wallet enumeration that bundles
// token balances, metadata (symbol/decimals/logo), and USD prices.
//
// Endpoint: POST /api/alchemy/portfolio/tokens/by-address
// Docs:     https://www.alchemy.com/docs/data/portfolio-apis/portfolio-api-endpoints/portfolio-api-endpoints/get-tokens-by-address
//
// We use this instead of the per-chain JSON-RPC trio
// (eth_getBalance + alchemy_getTokenBalances + alchemy_getTokenMetadata
// per ERC20) so a single call returns the entire wallet picture across
// every supported chain — no N+1 round-trips.

// The Portfolio API caps at 5 networks per address per request. The
// catalog in `lib/alchemy/networks.ts` is the source of truth for
// what's queryable; we send every catalog entry, chunked into
// 5-network batches, in parallel, and merge the results. This is
// independent of which chains the user can actually swap on — the
// card filters to swappable tokens at render time.
const PORTFOLIO_CHUNK_SIZE = 5;
export type PortfolioNetwork = AlchemyNetworkSlug;

export function networkToChainId(network: string): number | null {
  const entry = ALCHEMY_NETWORK_CATALOG[network as PortfolioNetwork];
  return entry?.chainId ?? null;
}

export type EnrichedToken = {
  chainId: number;
  network: PortfolioNetwork;
  /** Contract address. `null` for native ETH on the chain. */
  address: Address | null;
  /** Raw on-chain balance as a hex string (e.g. "0x5f5e100"). */
  tokenBalance: string;
  symbol: string;
  decimals: number;
  name: string;
  logo: string | null;
  /** USD spot price per 1 token. `null` if `withPrices` was off or the
   *  token is unpriced. */
  priceUsd: number | null;
  isNative: boolean;
};

type PortfolioResponse = {
  data?: {
    tokens?: RawToken[];
    pageKey?: string;
  };
};

type RawToken = {
  network?: string;
  tokenAddress?: string | null;
  tokenBalance?: string;
  tokenMetadata?: {
    symbol?: string;
    decimals?: number | string;
    name?: string;
    logo?: string;
  };
  tokenPrices?: Array<{
    currency?: string;
    value?: string | number;
    lastUpdatedAt?: string;
  }>;
};

const USD = "usd";

// Airdrop / claim-bait spam tokens: their Alchemy-mapped symbol/name is
// literally "Claim on: <scam-domain>" or "Airdrop on: <scam-domain>".
// Filtering at this layer keeps every downstream view clean.
const SPAM_NAME_RE = /(?:claim|airdrop|visit)\s+on\s*:/i;

// ponytail: pageKey is exposed by the API but our UI consumes the whole
// list at once; we cap at a single page (≈100 tokens) which is fine for
// any real-world wallet. Revisit if a user actually overflows this.
export async function fetchEnrichedBalances(
  address: Address,
  signal?: AbortSignal,
): Promise<EnrichedToken[]> {
  const allNetworks = Object.keys(ALCHEMY_NETWORK_CATALOG) as AlchemyNetworkSlug[];
  const chunks: AlchemyNetworkSlug[][] = [];
  for (let i = 0; i < allNetworks.length; i += PORTFOLIO_CHUNK_SIZE) {
    chunks.push(allNetworks.slice(i, i + PORTFOLIO_CHUNK_SIZE));
  }
  const responses = await Promise.all(
    chunks.map((networks) =>
      fetch("/api/alchemy/portfolio/tokens/by-address", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          addresses: [{ address, networks: [...networks] }],
          withMetadata: true,
          withPrices: true,
          includeNativeTokens: true,
          includeErc20Tokens: true,
        }),
        signal,
      }),
    ),
  );
  const out: EnrichedToken[] = [];
  for (const res of responses) {
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`portfolio ${res.status}${errText ? `: ${errText.slice(0, 200)}` : ""}`);
    }
    const json = (await res.json()) as PortfolioResponse;
    for (const t of json.data?.tokens ?? []) {
      const normalized = normalize(t);
      if (normalized) out.push(normalized);
    }
  }
  return out;
}

function normalize(token: RawToken): EnrichedToken | null {
  const network = token.network as PortfolioNetwork | undefined;
  const entry = network ? ALCHEMY_NETWORK_CATALOG[network] : null;
  if (!entry) return null;

  const meta = token.tokenMetadata ?? {};
  // Native entries have `tokenAddress: null`. Portfolio's native token
  // address varies per chain; we collapse it to null so the card treats
  // it like ETH. Alchemy never populates metadata for native tokens
  // (symbol/decimals/name all null across every chain we tested), so we
  // always backfill from the catalog's nativeToken entry.
  const isNative = token.tokenAddress == null;
  const address = isNative ? null : (token.tokenAddress as Address);

  const decimalsRaw = meta.decimals;
  const decimalsFromMeta =
    typeof decimalsRaw === "string"
      ? parseInt(decimalsRaw, 10)
      : typeof decimalsRaw === "number"
        ? decimalsRaw
        : null;
  const decimals = isNative ? entry.nativeToken.decimals : decimalsFromMeta;
  if (decimals == null || !Number.isFinite(decimals)) return null;
  // Airdrop / dust / scam tokens frequently carry decimals=0; real ERC20s
  // (USDC, WETH, WBTC, USDT, …) all use 6 or 18. Treat 0 as noise. The
  // catalog's native entries are all 18, so this only fires for ERC20s.
  if (decimals === 0) return null;

  const symbolFromMeta = meta.symbol?.trim() ?? "";
  const symbol = isNative ? entry.nativeToken.symbol : symbolFromMeta;
  if (!symbol) return null;
  // Drop tokens whose metadata screams "go claim me on a phishing site".
  if (SPAM_NAME_RE.test(symbol) || SPAM_NAME_RE.test(meta.name ?? "")) return null;

  // Filter zero-balance entries — they're noise (the user's wallet has
  // interacted with the contract at some point but holds nothing).
  // Native balances are always surfaced, even at 0, so the user can
  // see they exist on the chain.
  if (!isNative) {
    let raw: bigint;
    try {
      raw = BigInt(token.tokenBalance ?? "0x0");
    } catch {
      return null;
    }
    if (raw === BigInt(0)) return null;
  }

  const priceEntry = (token.tokenPrices ?? []).find((p) => p.currency?.toLowerCase() === USD);
  const priceValue = priceEntry?.value;
  const priceUsd =
    typeof priceValue === "string"
      ? parseFloat(priceValue)
      : typeof priceValue === "number"
        ? priceValue
        : null;

  return {
    chainId: entry.chainId,
    network: network as PortfolioNetwork,
    address,
    tokenBalance: token.tokenBalance ?? "0x0",
    symbol,
    decimals,
    name: meta.name?.trim() || (isNative ? entry.nativeToken.name : "") || symbol,
    logo: resolveLogo(token.tokenMetadata?.logo, isNative, entry.chainId, symbol),
    priceUsd: priceUsd != null && Number.isFinite(priceUsd) ? priceUsd : null,
    isNative,
  };
}

// Logo URL fallback chain. The Portfolio API ships `logo: null` for many
// tokens (every native balance, plus the long tail of obscure ERC20s),
// so we layer two more sources before giving up to the letter avatar:
//
//   1. Alchemy's own logo (when it bothers — works for major ERC20s)
//   2. Native balances reuse the chain's Alchemy emblem (Ethereum
//      diamond, polygon hexagon, etc. — visually = the native token)
//   3. ERC20s fall back to CoinCap's symbol-based icon CDN. No auth,
//      no rate limit for our scale, covers the full majors (ETH, USDC,
//      WETH, WBTC, USDT, MATIC, …). Long-tail tokens (toby, EBASE, …)
//      404 here and the card's <img onError> swaps to the letter avatar.
const COINCAP_ICON = (symbol: string) =>
  `https://assets.coincap.io/assets/icons/${symbol.toLowerCase()}@2x.png`;

function resolveLogo(
  alchemyLogo: string | null | undefined,
  isNative: boolean,
  chainId: number,
  symbol: string,
): string | null {
  if (alchemyLogo) return alchemyLogo;
  if (isNative) return getNetworkLogoByChainId(chainId);
  return COINCAP_ICON(symbol);
}
