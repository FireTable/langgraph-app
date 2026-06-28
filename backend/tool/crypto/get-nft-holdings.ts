import { tool } from "@langchain/core/tools";
import { z } from "zod";

const ALCHEMY_PORTFOLIO_BASE = "https://api.g.alchemy.com/data/v1";
const PAGE_SIZE = 100;

// Airdrop / claim-bait NFTs that slip past Alchemy's own `excludeSpam`.
// Mirrors SPAM_NAME_RE in lib/alchemy/portfolio.ts (token side) — same
// pattern, separate copy so a future tightening of one doesn't drag the
// other. Matched against contract name OR per-token name.
const SPAM_NAME_RE = /(?:claim|airdrop|visit|gift|giveaway|voucher|reward|drop|bonus)\b/i;

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

// Chains the portfolio card covers. Matches lib/alchemy/networks.ts's
// portfolio scope — Ethereum, Arbitrum, Optimism, Base, Polygon. Order
// is stable so chunked request URLs are deterministic for tests.
const NETWORKS = [
  "eth-mainnet",
  "arb-mainnet",
  "opt-mainnet",
  "base-mainnet",
  "polygon-mainnet",
];

type RawNft = {
  contract?: {
    address?: string;
    name?: string;
    symbol?: string;
    totalSupply?: string;
    tokenType?: string;
    openSeaMetadata?: {
      floorPrice?: number | string | null;
      collectionName?: string;
      collectionSlug?: string;
      imageUrl?: string;
    };
  };
  tokenId?: string;
  tokenType?: string;
  network?: string;
  name?: string;
  balance?: string;
  image?: {
    cachedUrl?: string;
    thumbnailUrl?: string;
    pngUrl?: string;
    originalUrl?: string;
    contentType?: string;
  };
};

type NormalizedNft = {
  contractAddress: string;
  contractName: string;
  collectionName: string | null;
  collectionSlug: string | null;
  contractImageUrl: string | null;
  network: string;
  tokenId: string;
  tokenType: string;
  name: string;
  thumbnailUrl: string | null;
  cachedUrl: string | null;
  balance: string;
};

function pickStr(...candidates: Array<string | null | undefined>): string | null {
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}

function normalize(raw: RawNft): NormalizedNft | null {
  const contract = raw.contract;
  const contractAddress = contract?.address;
  const contractName = contract?.name?.trim() ?? "";
  if (!contractAddress || !contractName) return null;
  if (SPAM_NAME_RE.test(contractName)) return null;
  const tokenName = raw.name?.trim() ?? "";
  if (SPAM_NAME_RE.test(tokenName)) return null;

  return {
    contractAddress,
    contractName,
    collectionName: contract.openSeaMetadata?.collectionName?.trim() || null,
    collectionSlug: contract.openSeaMetadata?.collectionSlug?.trim() || null,
    contractImageUrl: pickStr(contract.openSeaMetadata?.imageUrl),
    network: raw.network ?? "",
    tokenId: raw.tokenId ?? "",
    tokenType: raw.tokenType ?? contract.tokenType ?? "",
    name: tokenName || contractName,
    thumbnailUrl: pickStr(raw.image?.thumbnailUrl, raw.image?.cachedUrl),
    cachedUrl: pickStr(raw.image?.cachedUrl, raw.image?.originalUrl),
    balance: raw.balance ?? "1",
  };
}

async function fetchPage(
  apiKey: string,
  address: string,
  pageKey: string | undefined,
  signal?: AbortSignal,
): Promise<{ nfts: NormalizedNft[]; nextPageKey: string | null; totalCount: number }> {
  const url = `${ALCHEMY_PORTFOLIO_BASE}/${apiKey}/assets/nfts/by-address`;
  const body: Record<string, unknown> = {
    addresses: [{ address, networks: NETWORKS }],
    withMetadata: true,
    excludeSpam: true,
    pageSize: PAGE_SIZE,
  };
  if (pageKey) body.pageKey = pageKey;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    return Promise.reject(new Error(`alchemy ${res.status}`));
  }
  const json = (await res.json()) as {
    data?: { ownedNfts?: RawNft[]; pageKey?: string | null; totalCount?: number };
  };
  const owned = json.data?.ownedNfts ?? [];
  return {
    nfts: owned.map(normalize).filter((x): x is NormalizedNft => x !== null),
    nextPageKey: json.data?.pageKey ?? null,
    totalCount: json.data?.totalCount ?? owned.length,
  };
}

export const getNftHoldingsTool = tool(
  async ({ address }: { address: string }) => {
    if (!ADDRESS_RE.test(address)) {
      return JSON.stringify({
        success: false,
        error: "address must be a 0x-prefixed 40-hex string",
      });
    }
    const apiKey = process.env.ALCHEMY_API_KEY;
    if (!apiKey) {
      return JSON.stringify({
        success: false,
        error: "ALCHEMY_API_KEY is not configured on the server",
      });
    }

    try {
      const all: NormalizedNft[] = [];
      let totalCount = 0;
      let pageKey: string | undefined = undefined;
      // Hard cap to keep a pathological wallet from spinning the loop.
      // Alchemy caps at 1000 NFTs per wallet anyway (totalCount ceiling
      // for the free tier), but defending in depth.
      const MAX_PAGES = 20;
      for (let i = 0; i < MAX_PAGES; i++) {
        const page = await fetchPage(apiKey, address, pageKey);
        all.push(...page.nfts);
        totalCount = page.totalCount;
        if (!page.nextPageKey) break;
        pageKey = page.nextPageKey;
      }
      return JSON.stringify({
        success: true,
        address,
        totalCount,
        nfts: all,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return JSON.stringify({ success: false, error: msg });
    }
  },
  {
    name: "get_NFT_holdings",
    description:
      "List the NFT holdings of an EVM wallet across Ethereum, Arbitrum, Optimism, Base, and Polygon. Returns image URLs, contract name, collection slug, token id, and network for each NFT. Airdrop/claim-bait NFTs (yield-eth.net, USDC vouchers, etc.) are filtered out by name pattern in addition to Alchemy's own spam filter. The address must be a 0x-prefixed 40-hex string; the LLM should pull it from the user's message or the most recent connect_wallet ToolMessage, not invent one. If the wallet holds no NFTs, returns an empty list. Requires ALCHEMY_API_KEY to be configured on the server.",
    schema: z.object({
      address: z
        .string()
        .describe(
          "Wallet address, 0x-prefixed 40-hex chars. Case-insensitive. Pull from the user's message or a previous connect_wallet ToolMessage — never invent.",
        ),
    }),
  },
);
