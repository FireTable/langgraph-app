"use client";

import { createConfig, http } from "wagmi";
import { mainnet } from "wagmi/chains";
import { injected } from "wagmi/connectors";

// ponytail: display-only wagmi config. No writeContract, no sendTransaction —
// the crypto agent's "orders" are simulated (see backend/tool/crypto/confirm-crypto-order.ts).
// We use wagmi purely to surface the user's address + balance in the buy-intent card.
// Upgrade path: add useWriteContract for a real DEX swap (needs RPC + Router address in env).

export const wagmiConfig = createConfig({
  chains: [mainnet],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [mainnet.id]: http(),
  },
  ssr: true,
});
