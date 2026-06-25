"use client";

import { useEffect } from "react";
import { Loader2Icon, WalletIcon } from "lucide-react";
import { useConnect } from "wagmi";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Modal that lists every wagmi connector and lets the user pick one.
// `onConnected` fires once isConnected flips true so the caller can
// resume its own flow (e.g. submit the order that triggered the modal).
export function ConnectWalletDialog({
  open,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onConnected?: () => void;
}) {
  const { connectors, connect, isPending, error } = useConnect();

  useEffect(() => {
    if (!isPending && !error && open) {
      // wagmi sets isConnected on success; the parent effect resumes
      // its flow. We just clear the modal here once the wallet call
      // settles (success path is handled by the parent watching
      // isConnected; we only auto-close on user-initiated close).
    }
  }, [isPending, error, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="connect-wallet-dialog" className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Connect a wallet</DialogTitle>
          <DialogDescription>
            Pick a wallet to sign in. Orders are still simulated — no on-chain transaction is sent.
          </DialogDescription>
        </DialogHeader>

        <ul className="flex flex-col gap-2">
          {connectors.length === 0 ? (
            <li className="text-muted-foreground text-sm">No wallet providers detected.</li>
          ) : (
            connectors.map((c) => (
              <li key={c.uid}>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-start gap-3"
                  disabled={isPending}
                  onClick={() => {
                    connect(
                      { connector: c },
                      {
                        onSuccess: () => {
                          onConnected?.();
                          onOpenChange(false);
                        },
                      },
                    );
                  }}
                >
                  <WalletIcon className="size-4" />
                  <span className="flex-1 text-left">
                    {c.name}
                    <span className="text-muted-foreground ml-2 text-[10px] uppercase">
                      {c.type}
                    </span>
                  </span>
                  {isPending ? <Loader2Icon className="size-4 animate-spin" /> : null}
                </Button>
              </li>
            ))
          )}
        </ul>

        {error ? (
          <p className="text-destructive text-xs">Connection failed: {error.message}</p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
