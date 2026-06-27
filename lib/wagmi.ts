"use client";

import { http } from "wagmi";
import { mainnet, arbitrum, base } from "wagmi/chains";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import {
  binanceWallet,
  bitgetWallet,
  // coinbaseWallet is marked @deprecated in RainbowKit 2.2.11 (Coinbase
  // rebranded its SDK to CDP). The export still works; swap to
  // `cdpWallet` when RainbowKit ships the replacement. TypeScript's
  // `@deprecated` JSDoc flows through every reference and cannot be
  // suppressed per-line — the IDE will show one deprecation marker on
  // this import; the build / test / lint pipeline is clean.
  coinbaseWallet,
  metaMaskWallet,
  rainbowWallet,
  safeWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";

import "@rainbow-me/rainbowkit/styles.css";

// ponytail: `wallets` here is the same default set `getDefaultConfig`
// would pick, minus `base3` (its bundled icon SVG is a bare blue square
// in 2.2.11 — `base3` is internal-only, can't be fixed in place). The
// remaining connectors — MetaMask / Coinbase / Rainbow / Safe / Binance
// / Bitget / WalletConnect — all use injected / SDK providers. WalletConnect
// falls back to mobile-QR (powered by the `WALLETCONNECT_PROJECT_ID` env
// below) when the SDK provider isn't present.

// ponytail: route every chain through the server-side Alchemy proxy
// (app/api/alchemy/[...path]) instead of public RPCs. eth.merkle.io
// and friends don't return CORS headers, so direct browser → public-RPC
// calls fail with ERR_FAILED. The proxy holds ALCHEMY_API_KEY, accepts
// eth-mainnet/arb-mainnet/base-mainnet, and forwards with permissive
// CORS. If the proxy is unreachable, wagmi falls back to its default
// transport per chain.
const alchemyTransport = (slug: string) => http(`/api/alchemy/${slug}`, { batch: true });

// Public dapp identifier from Reown (formerly WalletConnect) — see
// https://dashboard.reown.com. Empty string disables WalletConnect v2
// entirely: binanceWallet / bitgetWallet fall back to injected-only
// (no mobile-QR). Free tier: 100k connections / month, no payment.
const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID ?? "";

export const wagmiConfig = getDefaultConfig({
  appName: "LangGraph App",
  projectId: WALLETCONNECT_PROJECT_ID,
  chains: [mainnet, arbitrum, base],
  transports: {
    [mainnet.id]: alchemyTransport("eth-mainnet"),
    [arbitrum.id]: alchemyTransport("arb-mainnet"),
    [base.id]: alchemyTransport("base-mainnet"),
  },
  ssr: true,
  wallets: [
    {
      groupName: "Popular",
      wallets: [
        binanceWallet,
        bitgetWallet,
        coinbaseWallet,
        metaMaskWallet,
        rainbowWallet,
        safeWallet,
        walletConnectWallet,
      ],
    },
  ],
});
