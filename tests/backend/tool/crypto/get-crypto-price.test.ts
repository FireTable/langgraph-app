import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  // Module-level price cache leaks between tests; force a fresh import.
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function loadTool() {
  const mod = await import("@/backend/tool/crypto/get-crypto-price");
  return mod.getCryptoPriceTool;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// CoinGecko /coins/markets shape, trimmed to fields we render.
const marketsResponse = [
  {
    id: "bitcoin",
    symbol: "btc",
    name: "Bitcoin",
    image: "https://assets.coingecko.com/coins/images/1/large/bitcoin.png",
    current_price: 67234.5,
    market_cap: 1325000000000,
    market_cap_rank: 1,
    total_volume: 25000000000,
    price_change_percentage_24h: 2.34,
    sparkline_in_7d: { price: [66000, 66500, 67000, 66800, 67200, 67234.5] },
  },
  {
    id: "ethereum",
    symbol: "eth",
    name: "Ethereum",
    image: "https://assets.coingecko.com/coins/images/279/large/ethereum.png",
    current_price: 3500.1,
    market_cap: 420000000000,
    market_cap_rank: 2,
    total_volume: 15000000000,
    price_change_percentage_24h: -1.12,
    sparkline_in_7d: { price: [3400, 3450, 3500, 3520, 3490, 3500.1] },
  },
];

describe("getCryptoPriceTool", () => {
  it("calls CoinGecko and returns a normalized coin list", async () => {
    const getCryptoPriceTool = await loadTool();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, marketsResponse));
    const out = await getCryptoPriceTool.invoke({ ids: ["bitcoin", "ethereum"] });
    const parsed = JSON.parse(out as string);
    expect(parsed.success).toBe(true);
    expect(parsed.coins).toHaveLength(2);
    expect(parsed.coins[0]).toMatchObject({
      id: "bitcoin",
      symbol: "BTC",
      name: "Bitcoin",
      current_price: 67234.5,
      price_change_percentage_24h: 2.34,
      sparkline: [66000, 66500, 67000, 66800, 67200, 67234.5],
    });
    expect(parsed.coins[0].image).toContain("bitcoin.png");
  });

  it("hits the coingecko base url with vs_currency=usd by default", async () => {
    const getCryptoPriceTool = await loadTool();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, marketsResponse));
    await getCryptoPriceTool.invoke({ ids: ["bitcoin"] });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toMatch(/^https:\/\/api\.coingecko\.com\/api\/v3\/coins\/markets\?/);
    expect(url).toContain("vs_currency=usd");
    expect(url).toContain("ids=bitcoin");
    expect(url).toContain("sparkline=true");
    expect(url).toContain("price_change_percentage=24h");
  });

  it("accepts a custom vs_currency", async () => {
    const getCryptoPriceTool = await loadTool();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, marketsResponse));
    await getCryptoPriceTool.invoke({ ids: ["bitcoin"], vs_currency: "cny" });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("vs_currency=cny");
  });

  it("propagates API failures as a serialized error result", async () => {
    const getCryptoPriceTool = await loadTool();
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { error: "rate limit" }));
    const out = await getCryptoPriceTool.invoke({ ids: ["bitcoin"] });
    const parsed = JSON.parse(out as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/429/);
  });

  it("returns an empty list when the API returns no coins for the given ids", async () => {
    const getCryptoPriceTool = await loadTool();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, []));
    const out = await getCryptoPriceTool.invoke({ ids: ["not-a-real-coin"] });
    const parsed = JSON.parse(out as string);
    expect(parsed.success).toBe(true);
    expect(parsed.coins).toEqual([]);
  });
});
