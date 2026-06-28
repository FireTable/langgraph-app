import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ALCHEMY_API_KEY;
});

async function loadTool() {
  const mod = await import("@/backend/tool/crypto/get-nft-holdings");
  return mod.getNftHoldingsTool;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Shape trimmed to fields the tool reads.
function makeNft(overrides: Record<string, unknown> = {}) {
  return {
    tokenId: "2",
    balance: "1",
    network: "base-mainnet",
    contract: {
      address: "0x6d4733bbe176fad22e9e8d069ba34781f792d9af",
      name: "Girl Base",
      symbol: "",
      totalSupply: "86",
      tokenType: "ERC721",
      openSeaMetadata: {
        floorPrice: null,
        collectionName: "Girl Base",
        collectionSlug: "girl-base",
        imageUrl: "https://i2c.seadn.io/base/collection.png",
      },
    },
    tokenType: "ERC721",
    name: "Girl Base #2",
    isSpam: null,
    image: {
      cachedUrl: "https://nft-cdn.alchemy.com/base-mainnet/abc",
      thumbnailUrl: "https://res.cloudinary.com/alchemyapi/thumb/abc",
      pngUrl: "https://res.cloudinary.com/alchemyapi/png/abc",
      contentType: "image/png",
      originalUrl: "https://didspaces.com/abc",
    },
    ...overrides,
  };
}

describe("getNftHoldingsTool", () => {
  it("rejects an address that is not 0x + 40 hex chars", async () => {
    process.env.ALCHEMY_API_KEY = "test-key";
    const getNftHoldingsTool = await loadTool();
    const out = await getNftHoldingsTool.invoke({ address: "not-an-address" });
    const parsed = JSON.parse(out as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/address/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns an error envelope when ALCHEMY_API_KEY is not set", async () => {
    delete process.env.ALCHEMY_API_KEY;
    const getNftHoldingsTool = await loadTool();
    const out = await getNftHoldingsTool.invoke({
      address: "0xc9c31b1Ad61713B10b30C38Fd88Ab0968B61EC33",
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/ALCHEMY_API_KEY/);
  });

  it("hits the Alchemy Portfolio nfts/by-address endpoint with the right shape", async () => {
    process.env.ALCHEMY_API_KEY = "test-key";
    const getNftHoldingsTool = await loadTool();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { ownedNfts: [], totalCount: 0 } }));
    await getNftHoldingsTool.invoke({
      address: "0xc9c31b1Ad61713B10b30C38Fd88Ab0968B61EC33",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.g.alchemy.com/data/v1/test-key/assets/nfts/by-address");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.addresses).toEqual([
      {
        address: "0xc9c31b1Ad61713B10b30C38Fd88Ab0968B61EC33",
        networks: expect.arrayContaining(["eth-mainnet", "arb-mainnet", "opt-mainnet", "base-mainnet", "polygon-mainnet"]),
      },
    ]);
    expect(body.withMetadata).toBe(true);
    expect(body.excludeSpam).toBe(true);
    expect(body.pageSize).toBe(100);
  });

  it("returns a normalized list of NFTs from a single page", async () => {
    process.env.ALCHEMY_API_KEY = "test-key";
    const getNftHoldingsTool = await loadTool();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: {
          ownedNfts: [makeNft({ tokenId: "2" }), makeNft({ tokenId: "3", name: "Girl Base #3" })],
          totalCount: 2,
          pageKey: null,
        },
      }),
    );
    const out = await getNftHoldingsTool.invoke({
      address: "0xc9c31b1Ad61713B10b30C38Fd88Ab0968B61EC33",
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.success).toBe(true);
    expect(parsed.address).toBe("0xc9c31b1Ad61713B10b30C38Fd88Ab0968B61EC33");
    expect(parsed.totalCount).toBe(2);
    expect(parsed.nfts).toHaveLength(2);
    expect(parsed.nfts[0]).toMatchObject({
      contractAddress: "0x6d4733bbe176fad22e9e8d069ba34781f792d9af",
      contractName: "Girl Base",
      collectionName: "Girl Base",
      collectionSlug: "girl-base",
      network: "base-mainnet",
      tokenId: "2",
      tokenType: "ERC721",
      name: "Girl Base #2",
      thumbnailUrl: "https://res.cloudinary.com/alchemyapi/thumb/abc",
      cachedUrl: "https://nft-cdn.alchemy.com/base-mainnet/abc",
    });
  });

  it("paginates with pageKey until the upstream returns null", async () => {
    process.env.ALCHEMY_API_KEY = "test-key";
    const getNftHoldingsTool = await loadTool();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: {
            ownedNfts: [makeNft({ tokenId: "2" })],
            totalCount: 3,
            pageKey: "page-2-token",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: {
            ownedNfts: [makeNft({ tokenId: "3", name: "Girl Base #3" })],
            totalCount: 3,
            pageKey: null,
          },
        }),
      );
    const out = await getNftHoldingsTool.invoke({
      address: "0xc9c31b1Ad61713B10b30C38Fd88Ab0968B61EC33",
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.nfts).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondBody.pageKey).toBe("page-2-token");
  });

  it("filters out airdrop-bait NFTs that slipped past excludeSpam", async () => {
    process.env.ALCHEMY_API_KEY = "test-key";
    const getNftHoldingsTool = await loadTool();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: {
          ownedNfts: [
            makeNft({ tokenId: "0", name: "Girl Base #0" }),
            makeNft({
              tokenId: "1",
              contract: {
                address: "0xspam",
                name: "yield-eth.net",
                symbol: "claim rewards on yield-eth.net",
                totalSupply: "1500",
                tokenType: "ERC1155",
              },
              name: "Visit yield-eth.net to claim rewards",
            }),
            makeNft({
              tokenId: "2",
              contract: {
                address: "0xvoucher",
                name: "USDC Voucher",
                symbol: "USDCV",
                totalSupply: "1000",
                tokenType: "ERC1155",
              },
              name: "5000 USDC Voucher (claim.circlest.org)",
            }),
          ],
          totalCount: 3,
          pageKey: null,
        },
      }),
    );
    const out = await getNftHoldingsTool.invoke({
      address: "0xc9c31b1Ad61713B10b30C38Fd88Ab0968B61EC33",
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.nfts).toHaveLength(1);
    expect(parsed.nfts[0].tokenId).toBe("0");
  });

  it("returns an empty list (not an error) when the wallet holds nothing", async () => {
    process.env.ALCHEMY_API_KEY = "test-key";
    const getNftHoldingsTool = await loadTool();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: { ownedNfts: [], totalCount: 0, pageKey: null } }),
    );
    const out = await getNftHoldingsTool.invoke({
      address: "0xc9c31b1Ad61713B10b30C38Fd88Ab0968B61EC33",
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.success).toBe(true);
    expect(parsed.nfts).toEqual([]);
    expect(parsed.totalCount).toBe(0);
  });

  it("propagates API failures as a serialized error result", async () => {
    process.env.ALCHEMY_API_KEY = "test-key";
    const getNftHoldingsTool = await loadTool();
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: "unauthorized" }));
    const out = await getNftHoldingsTool.invoke({
      address: "0xc9c31b1Ad61713B10b30C38Fd88Ab0968B61EC33",
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/401/);
  });

  it("normalizes NFTs that lack image data to null URLs (no crash)", async () => {
    process.env.ALCHEMY_API_KEY = "test-key";
    const getNftHoldingsTool = await loadTool();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: {
          ownedNfts: [
            makeNft({
              tokenId: "0",
              image: {},
              contract: {
                address: "0xnoimg",
                name: "No Image NFT",
                symbol: "",
                totalSupply: "1",
                tokenType: "ERC721",
                openSeaMetadata: {},
              },
            }),
          ],
          totalCount: 1,
          pageKey: null,
        },
      }),
    );
    const out = await getNftHoldingsTool.invoke({
      address: "0xc9c31b1Ad61713B10b30C38Fd88Ab0968B61EC33",
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.nfts[0]).toMatchObject({
      contractName: "No Image NFT",
      thumbnailUrl: null,
      cachedUrl: null,
      collectionName: null,
      collectionSlug: null,
    });
  });
});
