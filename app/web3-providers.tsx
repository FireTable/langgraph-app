"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { WagmiProvider, type Config } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";

import { wagmiConfig } from "@/lib/wagmi";

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
