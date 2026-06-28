// Browser stub for @/lib/alchemy/portfolio. Lets tests inject a fake
// wallet contents via window.__cryptoMockBalances without making real
// network calls. Falls back to a single USDC entry when nothing is
// set, so the place_crypto_order card always renders something.
import type { Address } from "viem";

type MockBalance = {
  chainId: number;
  address: Address | null;
  symbol: string;
  decimals: number;
  tokenBalance: string;
  name: string;
  logo: string | null;
  priceUsd: number | null;
  isNative: boolean;
};

const DEFAULT_BALANCES: MockBalance[] = [
  {
    chainId: 8453,
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    symbol: "USDC",
    decimals: 6,
    tokenBalance: "0xC350",
    name: "USD Coin",
    logo: null,
    priceUsd: 1,
    isNative: false,
  },
];

export async function fetchEnrichedBalances(
  _address: Address,
  _signal?: AbortSignal,
): Promise<MockBalance[]> {
  return (
    (globalThis as { __cryptoMockBalances?: MockBalance[] }).__cryptoMockBalances ??
    DEFAULT_BALANCES
  );
}
