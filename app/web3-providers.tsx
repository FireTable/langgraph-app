"use client";

import { useState, type ReactNode } from "react";
import { WagmiProvider, createConfig, http } from "wagmi";
import { mainnet } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ponytail: wagmi is display-only here — no writeContract, no signing. The
// crypto agent's orders are simulated; wagmi only surfaces address + balance
// in the buy-intent card. Lazy-init the QueryClient so React's strict-mode
// double-invoke doesn't share state across requests.
export function Web3Providers({ children }: { children: ReactNode }) {
  const [config] = useState(() =>
    createConfig({
      chains: [mainnet],
      connectors: [injected({ shimDisconnect: true })],
      transports: { [mainnet.id]: http() },
      ssr: true,
    }),
  );
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
