import { tool } from "@langchain/core/tools";
import { z } from "zod";

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";

// ponytail: 60s in-memory cache, key = sorted ids + vs_currency. CoinGecko
// free tier is ~10-30 req/min; agents that loop on the same query would
// blow through that without this. Upgrade path: Redis when we add #50.
const cache = new Map<string, { exp: number; value: string }>();
const CACHE_TTL_MS = 60_000;

type RawCoin = {
  id: string;
  symbol: string;
  name: string;
  image: string;
  current_price: number;
  market_cap: number;
  market_cap_rank: number;
  total_volume: number;
  price_change_percentage_24h: number;
  sparkline_in_7d: { price: number[] };
};

type Coin = {
  id: string;
  symbol: string;
  name: string;
  image: string;
  current_price: number;
  market_cap: number;
  market_cap_rank: number;
  total_volume: number;
  price_change_percentage_24h: number;
  sparkline: number[];
};

function normalize(raw: RawCoin): Coin {
  return {
    id: raw.id,
    symbol: raw.symbol.toUpperCase(),
    name: raw.name,
    image: raw.image,
    current_price: raw.current_price,
    market_cap: raw.market_cap,
    market_cap_rank: raw.market_cap_rank,
    total_volume: raw.total_volume,
    price_change_percentage_24h: raw.price_change_percentage_24h,
    sparkline: raw.sparkline_in_7d?.price ?? [],
  };
}

export const getCryptoPriceTool = tool(
  async ({ ids, vs_currency = "usd" }: { ids: string[]; vs_currency?: string }) => {
    const cacheKey = [...ids].sort().join(",") + "|" + vs_currency;
    const cached = cache.get(cacheKey);
    if (cached && cached.exp > Date.now()) return cached.value;

    // Note: CoinGecko uses `vs_currency` (singular) on /coins/markets —
    // the plural `vs_currencies` is only required by /simple/price.
    const params = new URLSearchParams({
      vs_currency,
      ids: ids.join(","),
      sparkline: "true",
      price_change_percentage: "24h",
    });
    const url = `${COINGECKO_BASE}/coins/markets?${params.toString()}`;

    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      return JSON.stringify({ success: false, error: `coingecko ${res.status}` });
    }
    const data = (await res.json()) as RawCoin[];
    const payload = JSON.stringify({
      success: true,
      coins: data.map(normalize),
    });
    cache.set(cacheKey, { exp: Date.now() + CACHE_TTL_MS, value: payload });
    return payload;
  },
  {
    name: "get_crypto_price",
    description:
      "Fetch current price, 24h change, 7-day sparkline, and market cap for one or more coins. Uses CoinGecko's public API (no key). ids are CoinGecko coin ids (e.g. 'bitcoin', 'ethereum', 'solana').",
    schema: z.object({
      ids: z.array(z.string()).min(1).describe("CoinGecko coin ids, e.g. ['bitcoin', 'ethereum']"),
      vs_currency: z
        .string()
        .default("usd")
        .describe("Quote currency code, e.g. 'usd', 'cny', 'eur'. Defaults to 'usd'."),
    }),
  },
);
