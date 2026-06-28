"use client";

import * as React from "react";
import { CheckCircle2Icon, Loader2Icon, WalletIcon } from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { useLangGraphSendCommand } from "@assistant-ui/react-langgraph";
import { useAccount } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";

import { Button } from "@/components/ui/button";
import { AddressOrHash } from "@/components/ui/address-or-hash";
import { unwrapToolResult } from "@/components/tool-ui/tool-result";

// ConnectWalletCard — one-shot wallet authorization. The backend tool
// (connect_wallet) pauses via interrupt(); the LLM's prompt message
// travels as the interrupt's `message` field and is rendered separately
// by the runtime, so this card reads only wallet state.
//
// Two views:
//
//   1. Wallet NOT connected → Connect button. Click opens RainbowKit.
//   2. Wallet connected (no resume yet) → tiny "Connecting" indicator;
//      a ref-guarded useEffect auto-resumes with {address, chainId} on
//      the first render where wagmi reports connected. The ref guards
//      against the Strict Mode dev double-invoke that previously caused
//      the second resume to consume an already-finished interrupt and
//      render as [object Object].
//   3. Resolved (result set) → confirmation row with the chosen address.
//
// Switching wallets: handled by the user's wallet app, not the card.
// RainbowKit's account modal still works if the user opens it
// elsewhere; the next tool that reads the address will see the new one.

type ResumePayload = { address: `0x${string}`; chainId: number } | { error: string };

function chainName(chainId: number | undefined): string {
  switch (chainId) {
    case 1:
      return "Ethereum";
    case 42161:
      return "Arbitrum One";
    case 8453:
      return "Base";
    case 11155111:
      return "Sepolia";
    default:
      return `Chain ${chainId ?? "?"}`;
  }
}

function parseResult(raw: unknown): ResumePayload | null {
  return unwrapToolResult<ResumePayload>(raw);
}

export const ConnectWalletCard: ToolCallMessagePartComponent<Record<string, never>> = ({
  result,
}) => {
  const sendCommand = useLangGraphSendCommand();
  const { address, isConnected, chainId } = useAccount();
  const { openConnectModal } = useConnectModal();

  const parsed = parseResult(result);

  // Auto-resume the moment wagmi reports a connected wallet. The ref
  // guard makes this Strict-Mode-safe: the dev double-invoke would
  // otherwise re-fire and consume the already-finished interrupt.
  const hasAutoResumedRef = React.useRef(false);
  React.useEffect(() => {
    if (hasAutoResumedRef.current) return;
    if (!isConnected || !address || !chainId) return;
    if (parsed) return; // resume already completed, no need to re-fire
    hasAutoResumedRef.current = true;
    sendCommand({ resume: JSON.stringify({ address, chainId }) });
  }, [isConnected, address, chainId, parsed, sendCommand]);

  if (parsed && "address" in parsed) {
    return (
      <div
        data-slot="connect-wallet-card-resolved"
        className="border-border/60 bg-card text-card-foreground my-2 max-w-md overflow-hidden rounded-xl border"
      >
        <div className="flex items-center gap-3 p-4">
          <div className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex size-9 shrink-0 items-center justify-center rounded-full">
            <CheckCircle2Icon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Wallet Connected</p>
            <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <AddressOrHash value={parsed.address} head={6} tail={4} asCode={false} />
              <span>· {chainName(parsed.chainId)}</span>
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (parsed && "error" in parsed) {
    return (
      <div
        data-slot="connect-wallet-card-error"
        className="text-destructive my-2 inline-flex items-center gap-1.5 text-xs"
      >
        Wallet connection cancelled: {parsed.error}
      </div>
    );
  }

  // Brief window: wagmi reports connected, the auto-resume useEffect is
  // about to fire (or just fired). Show a compact "Connecting" row so
  // the user knows the card is mid-flight, not stuck.
  if (isConnected && address && chainId) {
    return (
      <div
        data-slot="connect-wallet-card-connecting"
        className="border-border/60 bg-card text-card-foreground my-2 max-w-md overflow-hidden rounded-xl border"
      >
        <div className="flex items-center gap-3 p-4">
          <div className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-full">
            <Loader2Icon className="size-4 animate-spin" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Connecting…</p>
            <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <AddressOrHash value={address} head={6} tail={4} asCode={false} />
              <span>· {chainName(chainId)}</span>
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Default state — wallet not connected.
  return (
    <div
      data-slot="connect-wallet-card"
      className="border-border/60 bg-card text-card-foreground my-2 max-w-md overflow-hidden rounded-xl border"
    >
      <div className="flex flex-col gap-3 p-4">
        <header className="flex items-center gap-3">
          <div className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-full">
            <WalletIcon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Authorize Wallet</p>
            <p className="text-muted-foreground text-xs">Connect your wallet to continue.</p>
          </div>
        </header>
        <Button
          type="button"
          size="sm"
          onClick={() => openConnectModal?.()}
          data-action="connect-wallet"
        >
          Connect wallet
        </Button>
      </div>
    </div>
  );
};
