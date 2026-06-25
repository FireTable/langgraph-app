import { tool } from "@langchain/core/tools";
import { z } from "zod";

const FRANKFURTER_BASE = "https://api.frankfurter.app";

// ponytail: 60s in-memory cache, same pattern as get_crypto_price. ECB
// updates once a business day; agents that loop on the same pair would
// hammer frankfurter for nothing.
const cache = new Map<string, { exp: number; value: string }>();
const CACHE_TTL_MS = 60_000;

type FrankfurterResponse = {
  amount: number;
  base: string;
  date: string;
  rates: Record<string, number>;
};

export const getFxRateTool = tool(
  async ({ from, to }: { from: string; to: string }) => {
    const fromU = from.toUpperCase();
    const toU = to.toUpperCase();
    const cacheKey = `${fromU}|${toU}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.exp > Date.now()) return cached.value;

    const url = `${FRANKFURTER_BASE}/latest?from=${encodeURIComponent(fromU)}&to=${encodeURIComponent(toU)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      const payload = JSON.stringify({ success: false, error: `frankfurter ${res.status}` });
      cache.set(cacheKey, { exp: Date.now() + CACHE_TTL_MS, value: payload });
      return payload;
    }
    const data = (await res.json()) as FrankfurterResponse;
    const rate = data.rates[toU];
    if (typeof rate !== "number") {
      return JSON.stringify({ success: false, error: `no rate for ${toU}` });
    }
    const payload = JSON.stringify({
      success: true,
      from: fromU,
      to: toU,
      rate,
      date: data.date,
    });
    cache.set(cacheKey, { exp: Date.now() + CACHE_TTL_MS, value: payload });
    return payload;
  },
  {
    name: "get_fx_rate",
    description:
      "Look up the current FX rate between two ISO 4217 currency codes (e.g. 'USD', 'CNY', 'EUR', 'JPY', 'GBP'). Returns the rate and the ECB date stamp. Uses frankfurter.app — free, no key, ECB-sourced.",
    schema: z.object({
      from: z.string().length(3).describe("Base currency code, e.g. 'USD', 'CNY'."),
      to: z.string().length(3).describe("Quote currency code, e.g. 'USD', 'CNY'."),
    }),
  },
);
