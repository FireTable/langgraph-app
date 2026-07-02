"use client";

import { useCallback, useEffect, useState } from "react";
import { Brain } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import type { ProfileResponse, ThreadsResponse } from "@/lib/memory/validators";
import { cn } from "@/lib/utils";

// ponytail: Profile has three row kinds — session (read-only, hint
// "(from account)"), social-accounts (read-only, same hint, just the
// provider string), and store fields (the only rows the user can
// delete, hint "(saved by you)"). Mapping to two visual buckets keeps
// the affordance obvious: presence/absence of a Delete button.
type Row = { kind: "session" | "store" | "social"; key: string; value: string };

function buildRows(payload: ProfileResponse): Row[] {
  const rows: Row[] = [];
  if (payload.session.name)
    rows.push({ kind: "session", key: "name", value: payload.session.name });
  if (payload.session.email)
    rows.push({ kind: "session", key: "email", value: payload.session.email });
  if (payload.session.image)
    rows.push({ kind: "session", key: "image", value: payload.session.image });
  for (const account of payload.socialAccounts) {
    rows.push({ kind: "social", key: account.provider, value: account.provider });
  }
  for (const [key, value] of Object.entries(payload.profile)) {
    rows.push({ kind: "store", key, value: stringify(value) });
  }
  return rows;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

async function deleteProfile(key: string) {
  const res = await fetch(`/api/memory/profile/${encodeURIComponent(key)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`delete profile ${key} failed: ${res.status}`);
  return res;
}

async function deleteThread(threadId: string) {
  const res = await fetch(`/api/memory/threads/${encodeURIComponent(threadId)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404)
    throw new Error(`delete thread ${threadId} failed: ${res.status}`);
  return res;
}

export function MemoryView() {
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [threads, setThreads] = useState<ThreadsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [pRes, tRes] = await Promise.all([
        fetch("/api/memory/profile"),
        fetch("/api/memory/threads"),
      ]);
      if (!pRes.ok || !tRes.ok) {
        setError(`failed to load (${pRes.status}/${tRes.status})`);
        return;
      }
      setProfile((await pRes.json()) as ProfileResponse);
      setThreads((await tRes.json()) as ThreadsResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className="text-destructive p-6 text-sm" role="alert">
        {error}
      </div>
    );
  }
  if (!profile || !threads) {
    return <div className="text-muted-foreground p-6 text-sm">Loading memory…</div>;
  }

  const rows = buildRows(profile);

  const removeRow = async (key: string) => {
    await deleteProfile(key);
    await load();
  };
  const removeThread = async (threadId: string) => {
    await deleteThread(threadId);
    await load();
  };

  return (
    <div className="space-y-8 p-6">
      <header className="flex items-center gap-3">
        <Brain className="text-muted-foreground" aria-hidden />
        <h1 className="text-lg font-semibold">Memory</h1>
      </header>

      <section>
        <h2 className="mb-2 text-sm font-medium">Profile</h2>
        <ul className="divide-y rounded-md border">
          {rows.length === 0 ? (
            <li className="text-muted-foreground p-3 text-sm">No profile fields yet.</li>
          ) : (
            rows.map((row) => (
              <li
                key={`${row.kind}-${row.key}`}
                className="flex items-center justify-between gap-3 p-3 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-xs">{row.key}</div>
                  <div className="truncate">
                    {row.value || <span className="text-muted-foreground">(empty)</span>}
                  </div>
                </div>
                <span
                  className="text-muted-foreground text-xs"
                  data-hint={row.kind === "store" ? "saved-by-you" : "from-account"}
                >
                  {row.kind === "store" ? "(saved by you)" : "(from account)"}
                </span>
                {row.kind === "store" ? (
                  <button
                    type="button"
                    className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                    onClick={() => void removeRow(row.key)}
                  >
                    Delete
                  </button>
                ) : null}
              </li>
            ))
          )}
        </ul>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">Thread summaries</h2>
        {threads.threads.length === 0 ? (
          <p className="text-muted-foreground text-sm">No thread summaries yet.</p>
        ) : (
          <ul className="space-y-3">
            {threads.threads.map((group) => (
              <li key={group.threadId} className="rounded-md border p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-mono text-xs">{group.threadId}</div>
                  <button
                    type="button"
                    className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                    onClick={() => void removeThread(group.threadId)}
                  >
                    Delete all
                  </button>
                </div>
                <ul className="mt-2 space-y-1 text-sm">
                  {group.summaries.map((s) => (
                    <li key={`${s.threadId}:${s.sequence}`} className="flex justify-between gap-3">
                      <span>
                        <span className="font-mono text-xs">#{s.sequence}</span> {s.name}
                      </span>
                      <span className="text-muted-foreground text-xs truncate">
                        {s.description}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
