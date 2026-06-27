"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { WagmiProvider, type Config } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";

import { wagmiConfig } from "@/lib/wagmi";

// WalletConnect v2 modal emits HTML with `border="0"` on <img>, which
// React 19's stricter DOM validation rejects with "invalid border=0".
// The other 6 wallets (MetaMask / Coinbase / Rainbow / Safe / Binance
// / Bitget) work without WalletConnect, so the boundary falls back to
// wagmi-only — the user keeps the page, loses the picker modal. When
// RainbowKit or @walletconnect/ethereum-provider ships a React 19 fix,
// drop the boundary.
class WalletConnectBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("[web3-providers] RainbowKit crashed:", error, info);
  }
  render() {
    if (this.state.failed) return this.props.children;
    return (
      <RainbowKitProvider coolMode theme={lightTheme()} modalSize="wide">
        {this.props.children}
      </RainbowKitProvider>
    );
  }
}

export function Web3Providers({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig as unknown as Config}>
      <QueryClientProvider client={new QueryClient()}>
        <WalletConnectBoundary>{children}</WalletConnectBoundary>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
