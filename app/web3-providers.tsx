"use client";

import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, lightTheme, darkTheme } from "@rainbow-me/rainbowkit";

import { wagmiConfig } from "@/lib/wagmi";

// ponytail: wagmi is display-only here — no writeContract, no signing.
// The crypto agent's orders are simulated; wagmi only surfaces the
// connected address + balance, and RainbowKit provides the wallet
// picker modal the order button opens. Lazy-init the QueryClient
// and the RainbowKit theme so React strict-mode double-invoke doesn't
// share state across requests.
export function Web3Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={{
            lightMode: lightTheme(),
            darkMode: darkTheme(),
          }}
          modalSize="compact"
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
