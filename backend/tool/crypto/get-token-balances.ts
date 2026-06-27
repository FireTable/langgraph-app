import { tool } from "@langchain/core/tools";
import { z } from "zod";

// Alchemy network slugs for the chains we support. Matches the slug
// pattern used by app/api/alchemy/[...path]/route.ts. We only carry
// chains CoW is on (Ethereum / Arbitrum / Base); other chains the
// Alchemy proxy accepts (Polygon, Optimism, etc.) are intentionally
// not here until a swap path is added for them.
const CHAIN_TO_ALCHEMY_SLUG: Record<number, string> = {
  1: "eth-mainnet",
  42161: "arb-mainnet",
  8453: "base-mainnet",
};

// ponytail: EIP-55 checksum matters for re-routing into CoW. Wagmi gives
// us mixed-case addresses; we keep them as-is so the same address works
// in both the Alchemy and CoW calls.
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

type AlchemyBalance = { contractAddress: string; tokenBalance: string };
type AlchemyMetadata = {
  name?: string;
  symbol?: string;
  decimals?: number;
  logo?: string | null;
};

async function alchemyRpc(
  slug: string,
  key: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const res = await fetch(`https://${slug}.g.alchemy.com/v2/${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) {
    throw new Error(`alchemy ${res.status}`);
  }
  const json = (await res.json()) as {
    result?: unknown;
    error?: { message?: string };
  };
  if (json.error) {
    throw new Error(`alchemy: ${json.error.message ?? "unknown error"}`);
  }
  return json.result;
}

// Alchemy returns token balances as a hex string in the token's smallest
// unit. formatBalance converts to a human string without float drift by
// doing the division in bigint.
function formatBalance(hex: string, decimals: number): string {
  const value = BigInt(hex);
  const denom = BigInt(10) ** BigInt(decimals);
  const whole = value / denom;
  const frac = value % denom;
  if (frac === BigInt(0)) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
}

export const getTokenBalancesTool = tool(
  async ({ chainId, address }: { chainId: number; address: string }) => {
    const slug = CHAIN_TO_ALCHEMY_SLUG[chainId];
    if (!slug) {
      return JSON.stringify({ success: false, error: `chain_id ${chainId} is not supported` });
    }
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
      const balances = (await alchemyRpc(slug, apiKey, "alchemy_getTokenBalances", [
        address,
        "erc20",
      ])) as { tokenBalances: AlchemyBalance[] };

      const nonZero = balances.tokenBalances.filter((b) => BigInt(b.tokenBalance) > BigInt(0));
      if (nonZero.length === 0) {
        return JSON.stringify({ success: true, tokens: [] });
      }

      const tokens = await Promise.all(
        nonZero.map(async (b) => {
          const meta = (await alchemyRpc(slug, apiKey, "alchemy_getTokenMetadata", [
            b.contractAddress,
          ])) as AlchemyMetadata;
          const decimals = typeof meta.decimals === "number" ? meta.decimals : 18;
          return {
            contractAddress: b.contractAddress,
            symbol: meta.symbol ?? "UNKNOWN",
            name: meta.name ?? null,
            decimals,
            balance: formatBalance(b.tokenBalance, decimals),
            logo: meta.logo ?? null,
          };
        }),
      );
      return JSON.stringify({ success: true, tokens });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return JSON.stringify({ success: false, error: msg });
    }
  },
  {
    name: "get_token_balances",
    description:
      "List the ERC20 tokens a wallet currently holds on Ethereum, Arbitrum, or Base, with USD-denominated human-readable balances (USDC = 100, WETH = 0.1, etc.). Calls Alchemy's alchemy_getTokenBalances + alchemy_getTokenMetadata under the hood. The address must be the connected wallet's address (the LLM should pull it from the user's message context, not invent one). If the wallet holds no tokens on the requested chain, returns an empty list — not an error. Requires ALCHEMY_API_KEY to be configured on the server.",
    schema: z.object({
      chainId: z
        .number()
        .int()
        .describe("EVM chain id. One of 1 (Ethereum), 42161 (Arbitrum), 8453 (Base)."),
      address: z.string().describe("Wallet address, 0x-prefixed 40-hex chars. Case-insensitive."),
    }),
  },
);
