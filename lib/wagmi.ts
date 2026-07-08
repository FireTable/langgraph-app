"use client";

import { http } from "wagmi";
import { mainnet, arbitrum, base, sepolia } from "wagmi/chains";
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
  gateWallet,
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
//
// ponytail: viem's `http()` rejects a relative path — `createHttpProvider`
// throws "Provided URL is not compatible with HTTP connection: /api/..."
// when given a path with no scheme. viem does support relative URLs via
// window.location.origin on the client, but wallet-detection code (e.g.
// RainbowKit's AlchemyProvider for the wallet picker avatar) instantiates
// transports in a context where window may not exist, so the path falls
// through unprefixed. Pin to window.location.origin explicitly so the
// URL is always absolute on the client.
const alchemyTransport = (slug: string) =>
  http(`${typeof window !== "undefined" ? window.location.origin : ""}/api/alchemy/${slug}`, {
    batch: true,
  });

// Public dapp identifier from Reown (formerly WalletConnect) — see
// https://dashboard.reown.com. Empty string disables WalletConnect v2
// entirely: binanceWallet / bitgetWallet fall back to injected-only
// (no mobile-QR). Free tier: 100k connections / month, no payment.
const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID ?? "";

export const wagmiConfig = getDefaultConfig({
  appName: "FireTable",
  projectId: WALLETCONNECT_PROJECT_ID,
  chains: [mainnet, arbitrum, base, sepolia],
  transports: {
    [mainnet.id]: alchemyTransport("eth-mainnet"),
    [arbitrum.id]: alchemyTransport("arb-mainnet"),
    [base.id]: alchemyTransport("base-mainnet"),
    [sepolia.id]: alchemyTransport("eth-sepolia"),
  },
  ssr: true,
  wallets: [
    {
      groupName: "Popular",
      wallets: [
        binanceWallet,
        bitgetWallet,
        coinbaseWallet,
        gateWallet,
        metaMaskWallet,
        rainbowWallet,
        safeWallet,
        walletConnectWallet,
      ],
    },
  ],
});
