import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  fetchEnrichedBalances,
  networkToChainId,
  type EnrichedToken,
} from "@/lib/alchemy/portfolio";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("networkToChainId", () => {
  it("maps the three CoW chains", () => {
    expect(networkToChainId("eth-mainnet")).toBe(1);
    expect(networkToChainId("arb-mainnet")).toBe(42161);
    expect(networkToChainId("base-mainnet")).toBe(8453);
  });

  it("maps the rest of the original L1 + L2 catalog", () => {
    expect(networkToChainId("polygon-mainnet")).toBe(137);
    expect(networkToChainId("opt-mainnet")).toBe(10);
    expect(networkToChainId("bnb-mainnet")).toBe(56);
  });

  it("maps the newly added EVM L1 + L2 chains", () => {
    expect(networkToChainId("gnosis-mainnet")).toBe(100);
    expect(networkToChainId("unichain-mainnet")).toBe(130);
    expect(networkToChainId("berachain-mainnet")).toBe(80094);
    expect(networkToChainId("blast-mainnet")).toBe(81457);
    expect(networkToChainId("monad-mainnet")).toBe(143);
  });

  it("returns null for slugs outside the catalog", () => {
    expect(networkToChainId("optimism")).toBeNull();
    expect(networkToChainId("not-a-real-network")).toBeNull();
  });
});

describe("fetchEnrichedBalances — happy path", () => {
  it("posts to /api/alchemy/portfolio/tokens/by-address with the full catalog (no testnets)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { tokens: [] } }), { status: 200 }),
    );
    await fetchEnrichedBalances("0xabc");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/alchemy/portfolio/tokens/by-address");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.addresses[0].address).toBe("0xabc");
    const sent = body.addresses[0].networks;
    // Every L1 + L2 chain in the catalog — no testnets. The catalog
    // currently lists 20 mainnet EVM chains (8 L1 + 12 L2); pinned at
    // the Portfolio API's 1-20 per-request limit. If you add or remove
    // a chain, this test pins the expected request shape.
    expect(sent.length).toBe(20);
    expect(sent).toEqual(
      expect.arrayContaining([
        // L1
        "eth-mainnet",
        "polygon-mainnet",
        "bnb-mainnet",
        "avax-mainnet",
        "gnosis-mainnet",
        "berachain-mainnet",
        "monad-mainnet",
        "ronin-mainnet",
        // L2
        "arb-mainnet",
        "opt-mainnet",
        "base-mainnet",
        "linea-mainnet",
        "scroll-mainnet",
        "zksync-mainnet",
        "worldchain-mainnet",
        "unichain-mainnet",
        "blast-mainnet",
        "celo-mainnet",
        "apechain-mainnet",
        "soneium-mainnet",
      ]),
    );
    expect(sent).not.toEqual(
      expect.arrayContaining([
        "eth-sepolia",
        "arb-sepolia",
        "opt-sepolia",
        "polygon-amoy",
        "base-sepolia",
      ]),
    );
    expect(body.withMetadata).toBe(true);
    expect(body.withPrices).toBe(true);
    expect(body.includeNativeTokens).toBe(true);
    expect(body.includeErc20Tokens).toBe(true);
  });

  it("normalizes ERC20 tokens with metadata + USD price", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            tokens: [
              {
                network: "eth-mainnet",
                tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
                tokenBalance: "0x5f5e100",
                tokenMetadata: {
                  symbol: "USDC",
                  decimals: 6,
                  name: "USD Coin",
                  logo: "https://example.com/usdc.png",
                },
                tokenPrices: [{ currency: "usd", value: "1.0" }],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const out = await fetchEnrichedBalances("0xabc");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      chainId: 1,
      network: "eth-mainnet",
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "USDC",
      decimals: 6,
      name: "USD Coin",
      logo: "https://example.com/usdc.png",
      priceUsd: 1.0,
      isNative: false,
    });
    expect(out[0].tokenBalance).toBe("0x5f5e100");
  });

  it("normalizes native tokens (address=null, isNative=true)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            tokens: [
              {
                network: "arb-mainnet",
                tokenAddress: null,
                tokenBalance: "0x16345785d8a0000",
                tokenMetadata: {
                  symbol: "ETH",
                  decimals: 18,
                  name: "Ether",
                  logo: "https://example.com/eth.png",
                },
                tokenPrices: [{ currency: "usd", value: "3100.50" }],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const out: EnrichedToken[] = await fetchEnrichedBalances("0xabc");
    expect(out).toHaveLength(1);
    expect(out[0].chainId).toBe(42161);
    expect(out[0].address).toBeNull();
    expect(out[0].isNative).toBe(true);
    expect(out[0].symbol).toBe("ETH");
    expect(out[0].priceUsd).toBe(3100.5);
  });

  it("backfills native-token metadata from the catalog when Alchemy returns null (real API behavior)", async () => {
    // Real Portfolio API: native entries arrive with tokenAddress=null
    // and tokenMetadata = { symbol: null, decimals: null, name: null,
    // logo: null } on every chain we tested (Base, ETH-mainnet, …).
    // We must still render the native balance — the catalog carries the
    // fallback (ETH/18 for every L2 + most L1s; MATIC/18 on Polygon, etc.).
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            tokens: [
              {
                network: "base-mainnet",
                tokenAddress: null,
                tokenBalance: "0x7a4d4722fcde",
                tokenMetadata: {
                  symbol: null,
                  decimals: null,
                  name: null,
                  logo: null,
                },
                tokenPrices: [{ currency: "usd", value: "1580.91" }],
              },
              {
                network: "polygon-mainnet",
                tokenAddress: null,
                tokenBalance: "0x16345785d8a0000",
                tokenMetadata: {
                  symbol: null,
                  decimals: null,
                  name: null,
                  logo: null,
                },
                tokenPrices: [{ currency: "usd", value: "0.5" }],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const out = await fetchEnrichedBalances("0xabc");
    expect(out).toHaveLength(2);
    const base = out.find((t) => t.chainId === 8453);
    expect(base).toMatchObject({
      network: "base-mainnet",
      address: null,
      isNative: true,
      symbol: "ETH",
      decimals: 18,
      name: "Ether",
    });
    const polygon = out.find((t) => t.chainId === 137);
    expect(polygon).toMatchObject({
      network: "polygon-mainnet",
      isNative: true,
      symbol: "MATIC",
      decimals: 18,
      name: "Polygon",
    });
  });

  it("parses decimals delivered as a string", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            tokens: [
              {
                network: "base-mainnet",
                tokenAddress: "0x4200000000000000000000000000000000000006",
                tokenBalance: "0x1",
                tokenMetadata: { symbol: "WETH", decimals: "18" },
                tokenPrices: [],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const out = await fetchEnrichedBalances("0xabc");
    expect(out[0].decimals).toBe(18);
  });

  it("parses priceUsd delivered as a number", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            tokens: [
              {
                network: "eth-mainnet",
                tokenAddress: "0xtoken",
                tokenBalance: "0x1",
                tokenMetadata: { symbol: "X", decimals: 18 },
                tokenPrices: [{ currency: "usd", value: 0.0001 }],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const out = await fetchEnrichedBalances("0xabc");
    expect(out[0].priceUsd).toBe(0.0001);
  });
});

describe("fetchEnrichedBalances — logo fallback", () => {
  it("falls back to the chain emblem when Alchemy ships logo=null for a native token", async () => {
    // Real API behavior: native entries come with logo:null. The card
    // would render a letter avatar; we instead reuse the chain emblem
    // (Ethereum diamond, polygon hexagon, etc.) so the row matches the
    // gas token's actual iconography.
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            tokens: [
              {
                network: "base-mainnet",
                tokenAddress: null,
                tokenBalance: "0x1bc16d674ec80000",
                tokenMetadata: { symbol: null, decimals: null, name: null, logo: null },
                tokenPrices: [{ currency: "usd", value: "3000" }],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const out = await fetchEnrichedBalances("0xabc");
    expect(out[0].logo).toBe("https://static.alchemyapi.io/images/emblems/base-mainnet.svg");
  });

  it("falls back to CoinCap's symbol icon when Alchemy ships logo=null for an ERC20", async () => {
    // The long tail of obscure tokens (toby, EBASE, …) gets logo:null
    // from Alchemy. CoinCap covers the majors by symbol and the card's
    // onError handler hides anything CoinCap 404s on.
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            tokens: [
              {
                network: "eth-mainnet",
                tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
                tokenBalance: "0x5f5e100",
                tokenMetadata: { symbol: "USDC", decimals: 6, name: "USD Coin", logo: null },
                tokenPrices: [],
              },
              {
                network: "base-mainnet",
                tokenAddress: "0xebase",
                tokenBalance: "0x1",
                tokenMetadata: { symbol: "EBASE", decimals: 18, logo: null },
                tokenPrices: [],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const out = await fetchEnrichedBalances("0xabc");
    expect(out.find((t) => t.symbol === "USDC")?.logo).toBe(
      "https://assets.coincap.io/assets/icons/usdc@2x.png",
    );
    expect(out.find((t) => t.symbol === "EBASE")?.logo).toBe(
      "https://assets.coincap.io/assets/icons/ebase@2x.png",
    );
  });

  it("preserves Alchemy's logo when it ships a real URL (no fallback needed)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            tokens: [
              {
                network: "eth-mainnet",
                tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
                tokenBalance: "0x5f5e100",
                tokenMetadata: {
                  symbol: "USDC",
                  decimals: 6,
                  name: "USD Coin",
                  logo: "https://example.com/alchemy-usdc.png",
                },
                tokenPrices: [],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const out = await fetchEnrichedBalances("0xabc");
    expect(out[0].logo).toBe("https://example.com/alchemy-usdc.png");
  });
});

describe("fetchEnrichedBalances — defensive", () => {
  it("drops tokens from networks outside the catalog (e.g. 'optimism' typo)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            tokens: [
              {
                network: "optimism", // not a slug in the catalog
                tokenAddress: "0xmatic",
                tokenBalance: "0x1",
                tokenMetadata: { symbol: "OP", decimals: 18 },
                tokenPrices: [],
              },
              {
                network: "eth-mainnet",
                tokenAddress: "0xusdc",
                tokenBalance: "0x1",
                tokenMetadata: { symbol: "USDC", decimals: 6 },
                tokenPrices: [],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const out = await fetchEnrichedBalances("0xabc");
    expect(out).toHaveLength(1);
    expect(out[0].symbol).toBe("USDC");
  });

  it("drops testnet tokens", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            tokens: [
              {
                network: "eth-sepolia",
                tokenAddress: "0xfaucet",
                tokenBalance: "0x1",
                tokenMetadata: { symbol: "SEP", decimals: 18 },
                tokenPrices: [],
              },
              {
                network: "eth-mainnet",
                tokenAddress: "0xusdc",
                tokenBalance: "0x1",
                tokenMetadata: { symbol: "USDC", decimals: 6 },
                tokenPrices: [],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const out = await fetchEnrichedBalances("0xabc");
    expect(out).toHaveLength(1);
    expect(out[0].symbol).toBe("USDC");
  });

  it("drops tokens missing symbol or decimals", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            tokens: [
              {
                network: "eth-mainnet",
                tokenAddress: "0xa",
                tokenBalance: "0x1",
                tokenMetadata: { decimals: 6 },
              },
              {
                network: "eth-mainnet",
                tokenAddress: "0xb",
                tokenBalance: "0x1",
                tokenMetadata: { symbol: "X" },
              },
              {
                network: "eth-mainnet",
                tokenAddress: "0xc",
                tokenBalance: "0x1",
                tokenMetadata: { symbol: "OK", decimals: 18 },
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const out = await fetchEnrichedBalances("0xabc");
    expect(out).toHaveLength(1);
    expect(out[0].symbol).toBe("OK");
  });

  it("treats missing tokenPrices as null priceUsd", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            tokens: [
              {
                network: "eth-mainnet",
                tokenAddress: "0xabc",
                tokenBalance: "0x1",
                tokenMetadata: { symbol: "OBSCURE", decimals: 18 },
                tokenPrices: [],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const out = await fetchEnrichedBalances("0xabc");
    expect(out[0].priceUsd).toBeNull();
  });

  it("drops ERC20 entries with zero balance (dust / historical interactions)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            tokens: [
              {
                network: "eth-mainnet",
                tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
                tokenBalance: "0x0",
                tokenMetadata: { symbol: "USDC", decimals: 6 },
                tokenPrices: [{ currency: "usd", value: "1.0" }],
              },
              {
                network: "arb-mainnet",
                tokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
                tokenBalance: "0x0000000000000000000000000000000000000000000000000000000000000000",
                tokenMetadata: { symbol: "WETH", decimals: 18 },
                tokenPrices: [{ currency: "usd", value: "3000.0" }],
              },
              {
                network: "eth-mainnet",
                tokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
                tokenBalance: "0x1",
                tokenMetadata: { symbol: "WETH", decimals: 18 },
                tokenPrices: [{ currency: "usd", value: "3000.0" }],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const out = await fetchEnrichedBalances("0xabc");
    expect(out).toHaveLength(1);
    expect(out[0].symbol).toBe("WETH");
    expect(out[0].tokenBalance).toBe("0x1");
  });

  it("drops tokens with decimals=0 (airdrop / claim-bait pattern)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            tokens: [
              {
                network: "base-mainnet",
                tokenAddress: "0xbrett",
                tokenBalance: "0x42ad4",
                tokenMetadata: {
                  symbol: "Airdrop on: brettbased.com",
                  decimals: 0,
                },
                tokenPrices: [],
              },
              {
                network: "base-mainnet",
                tokenAddress: "0xusdc",
                tokenBalance: "0x1",
                tokenMetadata: { symbol: "USDC", decimals: 6 },
                tokenPrices: [],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const out = await fetchEnrichedBalances("0xabc");
    expect(out).toHaveLength(1);
    expect(out[0].symbol).toBe("USDC");
  });

  it("drops tokens whose symbol or name is a 'Claim on: <domain>' phishing pattern", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            tokens: [
              {
                network: "arb-mainnet",
                tokenAddress: "0xaero",
                tokenBalance: "0x1",
                tokenMetadata: {
                  symbol: "AERO",
                  name: "Claim on: rewards.aerodrome-network.com",
                  decimals: 18,
                },
                tokenPrices: [],
              },
              {
                network: "base-mainnet",
                tokenAddress: "0xbloo",
                tokenBalance: "0x1",
                tokenMetadata: {
                  symbol: "Claim on: bloo-foster.com/?claim",
                  decimals: 18,
                },
                tokenPrices: [],
              },
              {
                network: "base-mainnet",
                tokenAddress: "0xok",
                tokenBalance: "0x1",
                tokenMetadata: { symbol: "OK", name: "Some Real Token", decimals: 18 },
                tokenPrices: [],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const out = await fetchEnrichedBalances("0xabc");
    expect(out).toHaveLength(1);
    expect(out[0].symbol).toBe("OK");
  });

  it("ignores non-USD price entries", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            tokens: [
              {
                network: "eth-mainnet",
                tokenAddress: "0xabc",
                tokenBalance: "0x1",
                tokenMetadata: { symbol: "X", decimals: 18 },
                tokenPrices: [
                  { currency: "eur", value: "0.9" },
                  { currency: "usd", value: "1.0" },
                ],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const out = await fetchEnrichedBalances("0xabc");
    expect(out[0].priceUsd).toBe(1.0);
  });

  it("returns an empty array when data.tokens is missing", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    const out = await fetchEnrichedBalances("0xabc");
    expect(out).toEqual([]);
  });

  it("throws on non-200 responses with the status code", async () => {
    fetchMock.mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
    await expect(fetchEnrichedBalances("0xabc")).rejects.toThrow(/portfolio 429/);
  });
});
