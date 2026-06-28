"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { CheckCircle2Icon, ChevronDownIcon, WalletIcon } from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { useLangGraphSendCommand } from "@assistant-ui/react-langgraph";
import { useAccount } from "wagmi";
import { useAccountModal, useConnectModal } from "@rainbow-me/rainbowkit";

import { Button } from "@/components/ui/button";
import { AddressOrHash } from "@/components/ui/address-or-hash";
import { unwrapToolResult } from "@/components/tool-ui/tool-result";

// ConnectWalletCard — one-shot wallet authorization. The backend tool
// (connect_wallet) pauses via interrupt(); the LLM's prompt message
// travels as the interrupt's `message` field and is rendered separately
// by the runtime, so this card reads only wallet state.
//
// Three views:
//
//   1. Resolved (result set) → confirmation row with the chosen address.
//   2. Connected (no resume yet) → footer has Cancel (left) and a
//      segmented "Use this wallet" / dropdown-arrow (right). The
//      arrow opens a small menu with "Use a different wallet".
//   3. Not connected → single "Connect wallet" button.
//
// The card never auto-resumes — the user picks an action explicitly.

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
  const { openAccountModal } = useAccountModal();

  const parsed = parseResult(result);

  const cancel = () => sendCommand({ resume: JSON.stringify({ error: "cancelled" }) });

  if (parsed && "address" in parsed) {
    return (
      <div
        data-slot="connect-wallet-card-resolved"
        className="border-border/60 bg-card text-card-foreground max-w-md overflow-hidden rounded-xl border"
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
        className="text-destructive inline-flex items-center gap-1.5 text-xs"
      >
        Wallet connection cancelled: {parsed.error}
      </div>
    );
  }

  // Connected, awaiting confirmation. Footer = Cancel | segmented
  // [Use this wallet ▾]. The chevron half of the segmented control
  // opens a menu with "Use a different wallet".
  if (isConnected && address && chainId) {
    const resume = () => sendCommand({ resume: JSON.stringify({ address, chainId }) });
    return (
      <div
        data-slot="connect-wallet-card-connecting"
        className="border-border/60 bg-card text-card-foreground max-w-md overflow-hidden rounded-xl border"
      >
        <div className="flex flex-col gap-3 p-4">
          <header className="flex items-center gap-3">
            <div className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-full">
              <WalletIcon className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Authorize Wallet</p>
              <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <AddressOrHash value={address} head={6} tail={4} asCode={false} />
                <span>· {chainName(chainId)}</span>
              </p>
            </div>
          </header>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={cancel}
              data-action="cancel-connect"
            >
              Cancel
            </Button>
            <SegmentedConfirm onConfirm={resume} onSwitchWallet={() => openAccountModal?.()} />
          </div>
        </div>
      </div>
    );
  }

  // Default state — wallet not connected.
  return (
    <div
      data-slot="connect-wallet-card"
      className="border-border/60 bg-card text-card-foreground max-w-md overflow-hidden rounded-xl border"
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

// Segmented control: "Use this wallet" (main action) on the left,
// vertical divider, chevron trigger on the right that opens a menu.
// flex-1 fills the right column of the footer; the chevron stays a
// fixed width so the divider stays centered.
function SegmentedConfirm({
  onConfirm,
  onSwitchWallet,
}: {
  onConfirm: () => void;
  onSwitchWallet: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [menuPos, setMenuPos] = React.useState<{ top: number; right: number } | null>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  const updatePos = React.useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
  }, []);

  React.useEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    updatePos();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !(target as Element).closest?.("[data-slot=connect-wallet-menu]")
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("resize", updatePos);
    window.addEventListener("scroll", updatePos, true);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", updatePos);
      window.removeEventListener("scroll", updatePos, true);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, updatePos]);

  return (
    <div ref={rootRef} className="relative flex-1">
      <div
        className="divide-x divide-primary-foreground/20 flex w-full overflow-hidden rounded-md"
        data-slot="segmented-confirm"
      >
        <Button
          type="button"
          size="sm"
          className="flex-1 rounded-r-none"
          onClick={onConfirm}
          data-action="use-this-wallet"
        >
          Use this wallet
        </Button>
        <Button
          ref={triggerRef}
          type="button"
          size="sm"
          className="w-8 rounded-l-none px-0"
          onClick={() => setOpen((v) => !v)}
          aria-label="More options"
          aria-haspopup="menu"
          aria-expanded={open}
          data-action="connect-wallet-menu"
        >
          <ChevronDownIcon className="size-4" />
        </Button>
      </div>
      {open &&
        menuPos &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            data-slot="connect-wallet-menu"
            role="menu"
            style={{
              position: "fixed",
              top: menuPos.top,
              right: menuPos.right,
            }}
            className="border-border/60 bg-popover text-popover-foreground z-50 min-w-[12rem] overflow-hidden rounded-md border p-1 shadow-md"
          >
            <button
              type="button"
              role="menuitem"
              data-action="use-different-wallet"
              onClick={() => {
                onSwitchWallet();
                setOpen(false);
              }}
              className="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors"
            >
              Use a different wallet
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
