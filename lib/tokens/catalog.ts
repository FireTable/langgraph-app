// ponytail: hardcoded catalog of the common tokens the swap card offers.
// CoinGecko ids are the public identity the LLM uses (usd-coin, ethereum,
// wrapped-bitcoin, tether). On-chain, each chain has its own contract
// address + decimals. A token might also differ in symbol across chains
// (USDC.e vs USDC on Arbitrum).
//
// MVP scope: 4 tokens × 3 chains = 12 entries. Add a new token = drop one
// row per supported chain. Add a new chain = set the slug for each token
// (or omit to mark the token unavailable on that chain).
//
// CoW Protocol settlement requires every token to be on the SAME chain.
// We don't bridge — if a chain is missing for a token, the card hides it
// from the target dropdown for swaps on that chain.

import type { Address } from "viem";
import type { CowChainId } from "@/lib/swap/cow-config";

export type TokenSlug = "usdc" | "weth" | "usdt" | "wbtc";

export type TokenMeta = {
  slug: TokenSlug;
  coinId: string; // CoinGecko id
  symbol: string;
  name: string;
  decimals: number;
  // Stablecoins get 2-decimal display in the amount input + the quote
  // preview; everything else shows up to 6dp for sub-unit amounts.
  stable: boolean;
};

// Catalog rows, one per token (chain-independent metadata). Per-chain
// addresses live in CHAIN_ADDRESSES so adding a new chain only touches
// that map.
const TOKENS: TokenMeta[] = [
  {
    slug: "usdc",
    coinId: "usd-coin",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    stable: true,
  },
  {
    slug: "usdt",
    coinId: "tether",
    symbol: "USDT",
    name: "Tether",
    decimals: 6,
    stable: true,
  },
  {
    slug: "weth",
    coinId: "ethereum",
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    stable: false,
  },
  {
    slug: "wbtc",
    coinId: "wrapped-bitcoin",
    symbol: "WBTC",
    name: "Wrapped Bitcoin",
    decimals: 8,
    stable: false,
  },
];

// Per-chain token addresses. Missing chain → token unavailable there.
// Picked the canonical bridge / native USDC for each L2 (not USDC.e).
// EIP-55 mixed case (Alchemy returns checksummed; viem accepts either).
const CHAIN_ADDRESSES: Record<CowChainId, Partial<Record<TokenSlug, Address>>> = {
  1: {
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    usdt: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    wbtc: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  },
  42161: {
    // Arbitrum: native USDC (Circle) + bridged USDC.e. Catalog carries
    // the native one — it's what every modern wallet + DEX defaults to.
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC.e (bridged)
    usdt: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    wbtc: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
  },
  8453: {
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    usdt: "0xfde4C96c8593538E31C54eB48FDC2C8A5e1f9477",
    weth: "0x4200000000000000000000000000000000000006",
    wbtc: "0x0555E30da8f98308Edb960aa94C0Db47230d2B9c",
  },
};

export function getTokenMeta(slug: TokenSlug): TokenMeta {
  const t = TOKENS.find((x) => x.slug === slug);
  if (!t) throw new Error(`unknown token slug: ${slug}`);
  return t;
}

// Resolve a CoinGecko id to the token's address + decimals on the given
// chain. Returns null when the token isn't deployed on that chain.
export function resolveToken(
  coinId: string,
  chainId: CowChainId,
): { meta: TokenMeta; address: Address } | null {
  const meta = TOKENS.find((t) => t.coinId === coinId.toLowerCase());
  if (!meta) return null;
  const addr = CHAIN_ADDRESSES[chainId]?.[meta.slug];
  if (!addr) return null;
  return { meta, address: addr };
}

// Reverse lookup: which tokens are available on a given chain. Used by
// the target-token dropdown so the user never sees a token they can't
// actually receive.
export function tokensForChain(chainId: CowChainId): TokenMeta[] {
  return TOKENS.filter((t) => CHAIN_ADDRESSES[chainId]?.[t.slug]);
}

// Smart default for the target token. Sell a stablecoin → ETH; sell
// ETH/WBTC → USDC; no source hint → USDC. Keeps the preview realistic
// without asking the user to pick a target for the common case.
export function defaultTargetSlug(sourceSlug: TokenSlug | null): TokenSlug {
  if (sourceSlug == null) return "weth";
  if (sourceSlug === "usdc" || sourceSlug === "usdt") return "weth";
  return "usdc";
}
