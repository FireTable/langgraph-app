"use client";

import { useEffect, useState } from "react";
import { CoinsIcon } from "lucide-react";

import { QuotaProgress } from "@/components/credit/quota-progress";

// ponytail: read-only credit-usage indicator rendered inside the
// UserButton dropdown between the user header and the link list.
// Hits /api/credit/status (the same path the proxy uses for its
// quota gate) so the number on the surface and the gate that
// blocks the chat stay in lock-step — a single source of truth
// for "how much have I used".
//
// Two mounted instances coexist on every chat page (desktop sidebar +
// mobile sheet), and Radix DropdownMenu unmounts the content on
// close — so opening the menu re-mounts the slot and runs the
// effect again. A module-scope cache + in-flight promise collapses
// those duplicate fetches into one network round-trip; the 1s TTL
// guarantees the number refreshes every time the user pauses for
// more than a second before reopening the menu, which is the
// realistic "I want to see fresh data" cadence.
type Status = {
  used: number;
  limit: number | null;
  windowHours: number | null;
  resetAt: string;
  unlimited: boolean;
};

const CACHE_TTL_MS = 1_000;

let cache: { status: Status; expiresAt: number } | null = null;
let inflight: Promise<Status> | null = null;

async function loadStatus(): Promise<Status> {
  if (cache && cache.expiresAt > Date.now()) return cache.status;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch("/api/credit/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as Status;
      cache = { status: data, expiresAt: Date.now() + CACHE_TTL_MS };
      return data;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function CreditUsageSlot(): React.JSX.Element | null {
  const [status, setStatus] = useState<Status | null>(cache?.status ?? null);

  useEffect(() => {
    let cancelled = false;
    loadStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        // surface-less — the slot is decorative; failing to fetch
        // should never block the rest of the menu.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status) return null;

  if (status.unlimited) {
    return (
      <div className="flex flex-col gap-1 px-2 py-2.5">
        <div className="flex items-center gap-2 text-sm font-normal">
          <CoinsIcon className="size-4 text-muted-foreground" />
          <span>Usage</span>
        </div>
        <div className="text-muted-foreground pl-6 text-xs">No cap on this account</div>
      </div>
    );
  }
  if (status.limit == null || status.windowHours == null) return null;

  return (
    <div className="px-2 py-2.5">
      <QuotaProgress
        variant="slot"
        used={status.used}
        limit={status.limit}
        windowHours={status.windowHours}
        resetAt={status.resetAt}
      />
    </div>
  );
}
