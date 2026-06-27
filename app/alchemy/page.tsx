"use client";

import { useEffect, useState } from "react";
import { CoinsIcon, Loader2Icon, ZapIcon } from "lucide-react";

import {
  ALCHEMY_NETWORK_CATALOG,
  groupNetworks,
  type AlchemyNetworkEntry,
} from "@/lib/alchemy/networks";
import { cn } from "@/lib/utils";

type StatusState =
  | { kind: "loading" }
  | { kind: "configured" }
  | { kind: "unconfigured" }
  | { kind: "error"; message: string };

export default function AlchemyPage() {
  // The catalog is the source of truth for which networks the proxy
  // accepts. The optional `ALCHEMY_DISABLED_NETWORKS` denylist is read
  // server-side by the proxy; the client always shows the full catalog
  // so users can see what was turned off (a disabled network's Test
  // button returns 400).
  const groups = groupNetworks(Object.keys(ALCHEMY_NETWORK_CATALOG));
  const [status, setStatus] = useState<StatusState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/alchemy/status")
      .then((r) => r.json())
      .then((body: { configured?: boolean }) => {
        if (cancelled) return;
        setStatus(body.configured ? { kind: "configured" } : { kind: "unconfigured" });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="mx-auto max-w-3xl space-y-8 p-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Alchemy RPC</h1>
        <p className="text-muted-foreground text-sm">
          The Next.js app proxies JSON-RPC requests to Alchemy so the API key never reaches the
          browser. Pick a network below and hit <em>Test</em> to confirm the proxy round-trips.
        </p>
        <StatusBadge status={status} />
      </header>

      {groups.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="space-y-8">
          {groups.map((g) => (
            <section key={g.family} className="space-y-3">
              <h2 className="text-muted-foreground text-[11px] font-medium tracking-widest uppercase">
                {g.label}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {g.networks.map((n) => (
                  <NetworkCard key={n.slug} network={n} keyStatus={status.kind} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}

function StatusBadge({ status }: { status: StatusState }) {
  if (status.kind === "loading") {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
        <Loader2Icon className="size-3 animate-spin" /> Checking API key…
      </span>
    );
  }
  if (status.kind === "error") {
    return (
      <span className="text-destructive inline-flex items-center gap-1.5 text-xs">
        ⚠ {status.message}
      </span>
    );
  }
  if (status.kind === "unconfigured") {
    return (
      <span className="text-amber-700 dark:text-amber-400 inline-flex items-center gap-1.5 text-xs">
        <CoinsIcon className="size-3" /> API key not set — Test calls will return 500
      </span>
    );
  }
  return (
    <span className="text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1.5 text-xs">
      <ZapIcon className="size-3" /> API key configured
    </span>
  );
}

function NetworkCard({
  network,
  keyStatus,
}: {
  network: AlchemyNetworkEntry;
  keyStatus: StatusState["kind"];
}) {
  const [state, setState] = useState<"idle" | "running" | "ok" | "err">("idle");
  const [block, setBlock] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const onTest = async () => {
    setState("running");
    setErr(null);
    setBlock(null);
    try {
      const res = await fetch(`/api/alchemy/${network.slug}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
      });
      if (!res.ok) {
        const text = await res.text();
        setErr(`HTTP ${res.status} — ${text.slice(0, 80)}`);
        setState("err");
        return;
      }
      const body = (await res.json()) as { result?: string; error?: { message: string } };
      if (body.error) {
        setErr(body.error.message);
        setState("err");
        return;
      }
      setBlock(body.result ?? null);
      setState("ok");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setState("err");
    }
  };

  return (
    <div
      data-slot="alchemy-network-card"
      data-slug={network.slug}
      className="border-border/60 bg-card rounded-xl border p-4"
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">{network.name}</p>
          <p className="text-muted-foreground font-mono text-[11px]">{network.slug}</p>
        </div>
        <button
          type="button"
          onClick={onTest}
          disabled={state === "running" || keyStatus === "unconfigured"}
          className={cn(
            "border-input bg-background hover:bg-accent text-xs",
            "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          {state === "running" ? <Loader2Icon className="size-3 animate-spin" /> : null}
          {state === "ok" ? "✓" : state === "err" ? "✕" : null}
          {state === "running" ? "Running…" : "Test"}
        </button>
      </div>
      {state === "ok" && block ? (
        <p className="text-muted-foreground mt-2 font-mono text-[11px]">
          block: {block} ({parseInt(block, 16).toLocaleString()})
        </p>
      ) : null}
      {state === "err" && err ? (
        <p className="text-destructive mt-2 font-mono text-[11px]">{err}</p>
      ) : null}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="border-border/60 bg-muted/30 text-muted-foreground rounded-xl border p-6 text-sm">
      <p>
        <code className="font-mono">NEXT_PUBLIC_ALCHEMY_NETWORKS</code> is empty. Set it in{" "}
        <code className="font-mono">.env.local</code> as a comma-separated list of Alchemy network
        slugs.
      </p>
    </div>
  );
}
