import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.resetModules();
  process.env.ALCHEMY_API_KEY = "test-key-1234";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ALCHEMY_API_KEY;
});

async function loadTool() {
  const mod = await import("@/backend/tool/crypto/get-token-balances");
  return mod.getTokenBalancesTool;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function rpcResponse(result: unknown): Response {
  return jsonResponse(200, { jsonrpc: "2.0", id: 1, result });
}

const WALLET = "0x1234567890123456789012345678901234567890";
const USDC_ADDR = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const WETH_ADDR = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";

const SAMPLE_BALANCES = {
  address: WALLET,
  tokenBalances: [
    { contractAddress: USDC_ADDR, tokenBalance: "0x5f5e100" }, // 100 USDC (6 decimals)
    { contractAddress: WETH_ADDR, tokenBalance: "0x16345785d8a0000" }, // 0.1 WETH
  ],
};

const SAMPLE_METADATA = {
  name: "USD Coin",
  symbol: "USDC",
  decimals: 6,
  logo: "https://example.com/usdc.png",
};

describe("getTokenBalancesTool", () => {
  it("returns the user's non-zero ERC20 balances with metadata", async () => {
    const tool = await loadTool();

    // First call: alchemy_getTokenBalances
    fetchMock.mockResolvedValueOnce(rpcResponse(SAMPLE_BALANCES));
    // Second + third calls: alchemy_getTokenMetadata per token
    fetchMock.mockResolvedValueOnce(rpcResponse({ ...SAMPLE_METADATA }));
    fetchMock.mockResolvedValueOnce(
      rpcResponse({ name: "Wrapped Ether", symbol: "WETH", decimals: 18, logo: null }),
    );

    const out = await tool.invoke({ chainId: 42161, address: WALLET });
    const parsed = JSON.parse(out as string);

    expect(parsed.success).toBe(true);
    expect(parsed.tokens).toHaveLength(2);
    expect(parsed.tokens[0]).toMatchObject({
      contractAddress: USDC_ADDR,
      symbol: "USDC",
      decimals: 6,
      balance: "100",
    });
    expect(parsed.tokens[1]).toMatchObject({
      contractAddress: WETH_ADDR,
      symbol: "WETH",
      decimals: 18,
      balance: "0.1",
    });
  });

  it("filters out zero balances", async () => {
    const tool = await loadTool();
    fetchMock.mockResolvedValueOnce(
      rpcResponse({
        address: WALLET,
        tokenBalances: [
          { contractAddress: USDC_ADDR, tokenBalance: "0x5f5e100" },
          { contractAddress: WETH_ADDR, tokenBalance: "0x0" },
        ],
      }),
    );
    fetchMock.mockResolvedValueOnce(rpcResponse(SAMPLE_METADATA));

    const out = await tool.invoke({ chainId: 42161, address: WALLET });
    const parsed = JSON.parse(out as string);
    expect(parsed.tokens).toHaveLength(1);
    expect(parsed.tokens[0].contractAddress).toBe(USDC_ADDR);
  });

  it("returns an empty list when the wallet holds no tokens", async () => {
    const tool = await loadTool();
    fetchMock.mockResolvedValueOnce(rpcResponse({ address: WALLET, tokenBalances: [] }));
    const out = await tool.invoke({ chainId: 42161, address: WALLET });
    const parsed = JSON.parse(out as string);
    expect(parsed.success).toBe(true);
    expect(parsed.tokens).toEqual([]);
  });

  it("targets the right Alchemy host for each chainId", async () => {
    const tool = await loadTool();
    fetchMock.mockResolvedValueOnce(rpcResponse({ address: WALLET, tokenBalances: [] }));
    await tool.invoke({ chainId: 1, address: WALLET });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://eth-mainnet.g.alchemy.com/v2/test-key-1234");

    fetchMock.mockResolvedValueOnce(rpcResponse({ address: WALLET, tokenBalances: [] }));
    await tool.invoke({ chainId: 8453, address: WALLET });
    const [url2] = fetchMock.mock.calls[1] as [string];
    expect(url2).toBe("https://base-mainnet.g.alchemy.com/v2/test-key-1234");
  });

  it("rejects an unsupported chainId", async () => {
    const tool = await loadTool();
    const out = await tool.invoke({ chainId: 137, address: WALLET });
    const parsed = JSON.parse(out as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/137/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed address (not 0x + 40 hex)", async () => {
    const tool = await loadTool();
    const out = await tool.invoke({ chainId: 42161, address: "not-an-address" });
    const parsed = JSON.parse(out as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/address/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates Alchemy errors as a structured result", async () => {
    const tool = await loadTool();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { jsonrpc: "2.0", id: 1, error: { message: "invalid key" } }),
    );
    const out = await tool.invoke({ chainId: 42161, address: WALLET });
    const parsed = JSON.parse(out as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/403/);
  });

  it("errors cleanly when ALCHEMY_API_KEY is missing", async () => {
    delete process.env.ALCHEMY_API_KEY;
    const tool = await loadTool();
    const out = await tool.invoke({ chainId: 42161, address: WALLET });
    const parsed = JSON.parse(out as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/ALCHEMY_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
