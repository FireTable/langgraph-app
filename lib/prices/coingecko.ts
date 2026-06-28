// ponytail: browser-side CoinGecko price fetcher with in-memory cache.
// Used by the place-crypto-order card to compute receive amounts in real
// time. Free tier, no key needed.
//
// Fallback table is consulted when CoinGecko fails (rate-limit, network,
// etc.) so the demo never goes blank — the card shows a stale or fake
// price with a "fallback" tag instead.

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";

type PriceMap = Record<string, number>;

const cache = new Map<string, { exp: number; value: PriceMap }>();
const CACHE_TTL_MS = 30_000;

// ponytail: exported for tests only. Production callers never need it.
export function _resetPriceCacheForTests(): void {
  cache.clear();
}

// Hardcoded fallback prices in USD. Last-known-good values — used when
// CoinGecko is unreachable so the demo always shows a number. Add a
// slug here when adding a new well-known token.
const FALLBACK_PRICES_USD: Record<string, number> = {
  "usd-coin": 1,
  tether: 1,
  ethereum: 2500,
  "wrapped-bitcoin": 60000,
  bitcoin: 60000,
};

export async function fetchPrices(coinIds: string[], signal?: AbortSignal): Promise<PriceMap> {
  const wanted = [...new Set(coinIds.map((c) => c.toLowerCase()))];
  const result: PriceMap = {};

  // Pull anything still warm from the cache.
  const missing: string[] = [];
  for (const id of wanted) {
    const cached = cache.get(id);
    if (cached && cached.exp > Date.now()) result[id] = cached.value[id];
    else missing.push(id);
  }
  if (missing.length === 0) return result;

  try {
    // CoinGecko renamed `vs_currency` → `vs_currencies` (plural) on the
    // /simple/price endpoint in 2025. The singular form now returns
    // 422 "Missing parameter vs_currencies". The /coins/markets
    // endpoint still uses the singular form, so the two callers differ.
    const params = new URLSearchParams({
      vs_currencies: "usd",
      ids: missing.join(","),
    });
    const url = `${COINGECKO_BASE}/simple/price?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal,
    });
    if (!res.ok) throw new Error(`coingecko ${res.status}`);
    const raw = (await res.json()) as Record<string, { usd?: number }>;
    for (const id of missing) {
      const usd = raw[id]?.usd;
      if (typeof usd === "number" && Number.isFinite(usd)) {
        result[id] = usd;
        cache.set(id, { exp: Date.now() + CACHE_TTL_MS, value: { [id]: usd } });
      }
    }
  } catch {
    // Ignore — fall back below.
  }

  // Fill anything still missing from the hardcoded fallback table.
  for (const id of missing) {
    if (result[id] == null) {
      const fb = FALLBACK_PRICES_USD[id];
      if (fb != null) result[id] = fb;
    }
  }

  return result;
}

// Indicates whether a price came from a live fetch or the hardcoded
// fallback. The card renders a small tag so the user knows when the
// number isn't real.
export function priceIsFallback(coinId: string, price: number | undefined): boolean {
  if (price == null) return true;
  const fb = FALLBACK_PRICES_USD[coinId.toLowerCase()];
  return fb != null && fb === price;
}

// Mock Coin (MC) — the simulated-flow currency the user "spends" in every
// swap quote. Pegged to $1 USD so all conversions are 1:1 with USD. The
// wallet is auto-funded with MOCK_COIN_BALANCE on first interaction.
//
// Why $1: lets the user think in familiar numbers ("I have $10,000 to
// play with"), keeps the gas-tier cost comparison trivial (0.00018 ETH ≈
// $0.28 ≈ 0.28 MC), and avoids needing a price fetch for the source side
// of the quote. The card does NOT round-trip through USD — gas fees are
// converted directly via the live ETH/USD price the quote already loaded.

export const MOCK_COIN_ID = "mock-coin";
export const MOCK_COIN_USD = 1;
export const MOCK_COIN_SYMBOL = "MC";
export const MOCK_COIN_BALANCE = 10_000;

// Convert a USD value to Mock Coin (always 1:1, but keep the helper so
// the call sites read intent).
export function usdToMockCoin(usd: number): number {
  return usd / MOCK_COIN_USD;
}

// Convert a Mock Coin amount back to USD for sanity checks / tests.
export function mockCoinToUsd(mc: number): number {
  return mc * MOCK_COIN_USD;
}

// Convert an ETH-denominated gas fee to Mock Coin at the live ETH/USD
// price the quote already loaded. Rounded to 4 dp so the UI doesn't
// show "0.00018273 MC" — that level of precision is noise.
export function ethGasToMockCoin(ethAmount: number, ethUsd: number): number {
  if (!Number.isFinite(ethAmount) || !Number.isFinite(ethUsd) || ethUsd <= 0) return 0;
  const usd = ethAmount * ethUsd;
  return Number(usd.toFixed(4));
}
