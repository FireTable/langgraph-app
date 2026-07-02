"use client";

import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { ProfileResponse, ThreadsResponse } from "@/lib/memory/validators";
import { cn } from "@/lib/utils";

// ponytail: shape mirrors the shadcn Settings tabs — every section is a
// `h2 + Card/CardContent + Separator`. Row type encodes which affordance
// to render: session/social rows are read-only with an "(from account)"
// hint, store rows get a Delete button.
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
    const label = account.provider.charAt(0).toUpperCase() + account.provider.slice(1);
    rows.push({ kind: "social", key: account.provider, value: label });
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

export function MemoryView({ className }: { className?: string }) {
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
      <div className={cn("text-destructive p-6 text-sm", className)} role="alert">
        {error}
      </div>
    );
  }
  if (!profile || !threads) {
    return (
      <div className={cn("text-muted-foreground p-6 text-sm", className)}>Loading memory…</div>
    );
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
    <div className={cn("flex w-full flex-col gap-4 md:gap-6", className)}>
      <section>
        <h2 className="text-sm font-semibold mb-3">About you</h2>
        <Card className="p-0">
          <CardContent className="p-0">
            {rows.length === 0 ? (
              <p className="text-muted-foreground p-6 text-sm">No profile fields yet.</p>
            ) : (
              rows.map((row, index) => (
                <div key={`${row.kind}-${row.key}`}>
                  {index > 0 && <Separator />}
                  <div className="flex items-center justify-between gap-4 p-4">
                    <div className="min-w-0 flex-1">
                      <div className="text-muted-foreground text-xs">{row.key}</div>
                      <div className="truncate text-sm">
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
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void removeRow(row.key)}
                      >
                        <Trash2 aria-hidden />
                        Delete
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </section>

      <section>
        <h2 className="text-sm font-semibold mb-3">Thread summaries</h2>
        {threads.threads.length === 0 ? (
          <p className="text-muted-foreground text-sm">No thread summaries yet.</p>
        ) : (
          <Card className="p-0">
            <CardContent className="p-0">
              {threads.threads.map((group, index) => (
                <div key={group.threadId}>
                  {index > 0 && <Separator />}
                  <div className="space-y-2 p-4">
                    <div className="flex items-center justify-between gap-4">
                      <div className="text-muted-foreground text-xs">{group.threadId}</div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void removeThread(group.threadId)}
                        aria-label={`Delete all summaries for ${group.threadId}`}
                      >
                        <Trash2 aria-hidden />
                        Delete all
                      </Button>
                    </div>
                    <ul className="space-y-1 text-sm">
                      {group.summaries.map((s) => (
                        <li
                          key={`${s.threadId}:${s.sequence}`}
                          className="flex justify-between gap-3"
                        >
                          <span>
                            <span className="text-muted-foreground text-xs">#{s.sequence}</span>{" "}
                            {s.name}
                          </span>
                          <span className="text-muted-foreground text-xs truncate">
                            {s.description}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}
