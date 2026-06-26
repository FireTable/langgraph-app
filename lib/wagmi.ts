"use client";

import { http } from "wagmi";
import { mainnet } from "wagmi/chains";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";

import "@rainbow-me/rainbowkit/styles.css";

// ponytail: `projectId` here is a placeholder. WalletConnect won't work
// with it (any click on a WC wallet fails to init), but injected wallets
// (MetaMask, Rabby, Phantom) and the Coinbase connector don't touch it
// and work normally. Swap for a real id from cloud.walletconnect.com
// when WalletConnect support is actually needed.
export const wagmiConfig = getDefaultConfig({
  appName: "LangGraph App",
  projectId: "placeholder-replace-me",
  chains: [mainnet],
  transports: { [mainnet.id]: http() },
  ssr: true,
});
