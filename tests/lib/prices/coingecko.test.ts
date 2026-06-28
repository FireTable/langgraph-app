import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchPrices, priceIsFallback, _resetPriceCacheForTests } from "@/lib/prices/coingecko";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  _resetPriceCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchPrices", () => {
  it("returns parsed prices from a successful CoinGecko /simple/price call", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ tether: { usd: 1.001 }, "wrapped-bitcoin": { usd: 61234 } }),
    );
    const prices = await fetchPrices(["tether", "wrapped-bitcoin"]);
    expect(prices.tether).toBe(1.001);
    expect(prices["wrapped-bitcoin"]).toBe(61234);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("falls back to hardcoded prices when CoinGecko returns a non-OK status", async () => {
    fetchMock.mockResolvedValueOnce(new Response("rate limit", { status: 429 }));
    const prices = await fetchPrices(["tether", "wrapped-bitcoin"]);
    expect(prices.tether).toBe(1); // fallback
    expect(prices["wrapped-bitcoin"]).toBe(60000); // fallback
  });

  it("falls back to hardcoded prices when CoinGecko omits a requested id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ tether: { usd: 1.001 } }));
    const prices = await fetchPrices(["tether", "wrapped-bitcoin"]);
    expect(prices.tether).toBe(1.001); // live
    expect(prices["wrapped-bitcoin"]).toBe(60000); // fallback
  });

  it("uses the in-memory cache for repeated lookups within the TTL", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ "wrapped-bitcoin": { usd: 61500 } }));
    await fetchPrices(["wrapped-bitcoin"]);
    await fetchPrices(["wrapped-bitcoin"]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("dedupes ids and normalizes case before requesting", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ tether: { usd: 1 }, "wrapped-bitcoin": { usd: 60000 } }),
    );
    await fetchPrices(["Tether", "Tether", "Wrapped-Bitcoin"]);
    const url = (fetchMock.mock.calls[0]?.[0] as string) ?? "";
    expect(url).toContain("ids=tether%2Cwrapped-bitcoin");
  });
});

describe("priceIsFallback", () => {
  it("returns true when the price equals the fallback value", () => {
    expect(priceIsFallback("ethereum", 2500)).toBe(true);
    expect(priceIsFallback("usd-coin", 1)).toBe(true);
  });

  it("returns false when the price differs from the fallback value", () => {
    expect(priceIsFallback("ethereum", 2400)).toBe(false);
  });

  it("returns true when the price is undefined", () => {
    expect(priceIsFallback("ethereum", undefined)).toBe(true);
  });

  it("returns false for an unknown coin with any numeric price", () => {
    // No fallback table entry → cannot be "the fallback value".
    expect(priceIsFallback("totally-unknown-coin", 42)).toBe(false);
  });
});
