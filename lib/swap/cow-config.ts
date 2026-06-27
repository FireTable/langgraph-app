// CoW Protocol config — the only thing we need to hardcode now that
// the swap path goes through CoW's solver network instead of a
// hand-curated Uniswap V3 router list.
//
// ponytail: this file is the single source of truth for CoW endpoints
// + the EIP-712 settlement contract. Both the backend quote tool
// (backend/tool/crypto/get-swap-quote.ts) and the frontend EIP-712
// signer (components/tool-ui/crypto/confirm-card.tsx) import from
// here. Add a chain = drop a row in COW_API. That's it.

export const COW_SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41" as const;

// Settlement contract chainId — same address on every EVM chain (CREATE2),
// but the EIP-712 domain needs the chainId of the chain the user is
// signing for, so callers pass it explicitly.

export const COW_API: Record<number, { apiUrl: string; name: string }> = {
  1: { apiUrl: "https://api.cow.fi/mainnet/api/v1", name: "Ethereum" },
  42161: { apiUrl: "https://api.cow.fi/arbitrum_one/api/v1", name: "Arbitrum One" },
  8453: { apiUrl: "https://api.cow.fi/base/api/v1", name: "Base" },
};

export type CowChainId = keyof typeof COW_API;

export function getCowConfig(chainId: number | null | undefined) {
  if (chainId == null) return null;
  return COW_API[chainId] ?? null;
}

// EIP-712 domain for CoW orders. `verifyingContract` is the settlement
// contract; `chainId` is the chain the order is being placed on. The
// version string is fixed — the protocol bumps it only on contract
// upgrades that change the order schema.
export const COW_EIP712_DOMAIN = (chainId: CowChainId) => ({
  name: "Gnosis Protocol" as const,
  version: "v2" as const,
  chainId,
  verifyingContract: COW_SETTLEMENT,
});

// CoW order typed-data schema. Mirrors the contract's Order struct;
// keep in sync with the protocol.
export const COW_EIP712_TYPES = {
  Order: [
    { name: "sellToken", type: "address" },
    { name: "buyToken", type: "address" },
    { name: "receiver", type: "address" },
    { name: "sellAmount", type: "uint256" },
    { name: "buyAmount", type: "uint256" },
    { name: "validTo", type: "uint32" },
    { name: "appData", type: "bytes32" },
    { name: "feeAmount", type: "uint256" },
    { name: "kind", type: "string" },
    { name: "partiallyFillable", type: "bool" },
    { name: "sellTokenBalance", type: "string" },
    { name: "buyTokenBalance", type: "string" },
  ],
} as const;
