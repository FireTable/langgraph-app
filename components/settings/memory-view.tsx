"use client";

import { useCallback, useEffect, useState } from "react";
import { Bot, User, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { JsonBlock } from "@/components/tool-ui/primitives/json-block";
import { CopyButton } from "@/components/ui/copy-button";
import { mergeMemory, type AuthInfo, type MemoryDoc } from "@/lib/memory/merge";
import { AUTH_OVERLAY_KEYS, type AuthOverlayKey } from "@/lib/memory/constants";
import { prettifyKey } from "@/lib/memory/format";
import type { SummaryEntry } from "@/lib/memory/validators";
import { cn } from "@/lib/utils";

// ponytail: the API returns {store, auth, threads} as separate
// fields. The UI runs the same mergeMemory the model uses on the
// system-prompt side, then classifies each merged field as
// "summarized by AI" (key present in store) vs "from account" (key
// filled only by the auth overlay). Single source of truth for
// merge logic across backend / frontend.
type MemoryResponse = {
  store: MemoryDoc;
  auth: AuthInfo;
  threads: Array<{ key: string; value: SummaryEntry }>;
};

type Row = { kind: "store" | "account"; key: string; value: string };

function buildRows(store: MemoryDoc, auth: AuthInfo): Row[] {
  const merged = mergeMemory(store, auth);
  const storeKeys = new Set(Object.keys(store));
  const storeKeyList = [...storeKeys].sort();
  // ponytail: account rows first in AUTH_OVERLAY_KEYS order (stable:
  // name, email, image, socials), then store rows alphabetically.
  const accountOrder = new Map<AuthOverlayKey, number>(AUTH_OVERLAY_KEYS.map((k, i) => [k, i]));
  const rows: Row[] = Object.entries(merged).map(([key, value]) => ({
    key,
    value: stringify(value),
    kind: storeKeys.has(key) ? "store" : "account",
  }));
  return rows.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "account" ? -1 : 1;
    if (a.kind === "account" && b.kind === "account") {
      const ai = accountOrder.get(a.key as AuthOverlayKey) ?? 0;
      const bi = accountOrder.get(b.key as AuthOverlayKey) ?? 0;
      return ai - bi;
    }
    return storeKeyList.indexOf(a.key) - storeKeyList.indexOf(b.key);
  });
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

// ponytail: structured values (object/array) render as a pretty-printed
// JSON block — same shape the user already sees in the save_memory
// card's CHANGED row, so the two surfaces read consistently. Primitive
// leaves stay inline so single-value rows like "Role: engineering
// manager" don't get their own code block.
type ValueNode = { kind: "leaf"; display: string } | { kind: "branch"; raw: unknown };

function toNode(value: unknown): ValueNode {
  if (value === null || value === undefined) return { kind: "leaf", display: "(empty)" };
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { kind: "leaf", display: String(value) };
  }
  // ponytail: keep the original JS shape (object/array) so the renderer
  // can dump it via JSON.stringify without losing keys or array order.
  return { kind: "branch", raw: value };
}

function NestedValue({ node }: { node: ValueNode }) {
  if (node.kind === "leaf") {
    return <span className="text-foreground text-sm">{node.display}</span>;
  }
  // ponytail: same JsonBlock the observability panel uses for span
  // payloads. maxHeight caps the height so a deep profile field
  // (e.g. travel_preferences with many keys) can't push the rest of
  // the card off-screen — overflow scrolls inside the block.
  const json = JSON.stringify(node.raw, null, 2);
  return (
    <div className="relative mt-1.5">
      <JsonBlock data={node.raw} maxHeight={240} />
      <CopyButton
        className="absolute top-1.5 right-1.5"
        getTextAction={() => json}
        label="Copy JSON"
      />
    </div>
  );
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
  const [memory, setMemory] = useState<MemoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ponytail: dialog content reads `displayTarget*` so the description
  // stays stable across the close animation. `pendingProfileKey` flips
  // the dialog open/closed; `displayTargetProfile` only updates when a
  // NEW dialog opens — close-only events never clear it, so Radix can
  // finish its zoom-out animation without the description going null
  // mid-transition.
  const [pendingProfileKey, setPendingProfileKey] = useState<string | null>(null);
  const [pendingThreadId, setPendingThreadId] = useState<string | null>(null);
  const [displayTargetProfile, setDisplayTargetProfile] = useState<string | null>(null);
  const [displayTargetThread, setDisplayTargetThread] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/memory/profile");
      if (!res.ok) {
        setError(`failed to load (${res.status})`);
        return;
      }
      setMemory((await res.json()) as MemoryResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ponytail: clear the display targets AFTER the dialog close animation
  // finishes — 250ms matches Radix's data-[state=closed] duration. If we
  // cleared immediately, the description would flicker to null mid-fade.
  useEffect(() => {
    if (pendingProfileKey !== null) return;
    const t = setTimeout(() => setDisplayTargetProfile(null), 250);
    return () => clearTimeout(t);
  }, [pendingProfileKey]);
  useEffect(() => {
    if (pendingThreadId !== null) return;
    const t = setTimeout(() => setDisplayTargetThread(null), 250);
    return () => clearTimeout(t);
  }, [pendingThreadId]);

  if (error) {
    return (
      <div className={cn("text-destructive p-6 text-sm", className)} role="alert">
        {error}
      </div>
    );
  }
  if (!memory) {
    return (
      <div className={cn("text-muted-foreground p-6 text-sm", className)}>Loading memory…</div>
    );
  }

  const rows = buildRows(memory.store, memory.auth);
  // The /api/memory/threads endpoint groups summaries by thread.
  // We pass-through the threads array here; the Thread summaries
  // card below uses its own fetch so this kept wire-level identical.
  const threadGroups = memory.threads.map((entry) => ({
    threadId: entry.value.threadId,
    summaries: [entry.value],
  }));

  const openProfileDialog = (key: string) => {
    setDisplayTargetProfile(key);
    setPendingProfileKey(key);
  };
  const openThreadDialog = (threadId: string) => {
    setDisplayTargetThread(threadId);
    setPendingThreadId(threadId);
  };
  const confirmRemoveRow = async () => {
    const key = pendingProfileKey;
    setPendingProfileKey(null);
    if (!key) return;
    try {
      await deleteProfile(key);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const confirmRemoveThread = async () => {
    const threadId = pendingThreadId;
    setPendingThreadId(null);
    if (!threadId) return;
    try {
      await deleteThread(threadId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <TooltipProvider delayDuration={150}>
      <div className={cn("flex w-full flex-col gap-4 md:gap-6", className)}>
        <section>
          <h2 className="text-sm font-semibold mb-1">About you</h2>
          <p className="text-muted-foreground mb-3 text-xs leading-relaxed">
            Here is what our chat remembers about you, so future conversations don&apos;t have to
            start from scratch. You can edit, delete, or add anything you like.
          </p>
          <Card className="p-0">
            <CardContent className="p-0">
              {rows.length === 0 ? (
                <p className="text-muted-foreground p-6 text-sm">No profile fields yet.</p>
              ) : (
                rows.map((row, index) => {
                  const node = toNode(parseValue(row.value));
                  const isPrimitive = node.kind === "leaf";
                  return (
                    <div key={`${row.kind}-${row.key}`}>
                      {index > 0 && <Separator />}
                      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2 px-4 py-3">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              aria-label={
                                row.kind === "store"
                                  ? "Summarized by AI — written by your assistant during a past conversation"
                                  : "From your account — read from your login profile"
                              }
                              className="text-muted-foreground hover:text-foreground inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-muted"
                              data-hint={row.kind === "store" ? "summarized-by-ai" : "from-account"}
                            >
                              {row.kind === "store" ? (
                                <Bot className="size-5" aria-hidden />
                              ) : (
                                <User className="size-5" aria-hidden />
                              )}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            {row.kind === "store"
                              ? "Summarized by AI — written by your assistant during a past conversation. You can delete this."
                              : "From your account — read from your login profile. Edit it in account settings."}
                          </TooltipContent>
                        </Tooltip>
                        <div className="min-w-0">
                          <div className="text-muted-foreground text-xs">
                            {prettifyKey(row.key)}
                          </div>
                          <div className="mt-0.5">
                            {isPrimitive ? (
                              <div className="text-sm">
                                {row.value || (
                                  <span className="text-muted-foreground">(empty)</span>
                                )}
                              </div>
                            ) : (
                              <NestedValue node={node} />
                            )}
                          </div>
                        </div>
                        {row.kind === "store" ? (
                          <Button
                            type="button"
                            className="ml-auto shrink-0"
                            variant="outline"
                            size="sm"
                            onClick={() => openProfileDialog(row.key)}
                            aria-label={`Delete ${prettifyKey(row.key)}`}
                          >
                            <Trash2 aria-hidden />
                            Delete
                          </Button>
                        ) : (
                          <span aria-hidden />
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
        </section>

        <section>
          <h2 className="text-sm font-semibold mb-3">Thread summaries</h2>
          {threadGroups.length === 0 ? (
            <p className="text-muted-foreground text-sm">No thread summaries yet.</p>
          ) : (
            <Card className="p-0">
              <CardContent className="p-0">
                {threadGroups.map((group, index) => (
                  <div key={group.threadId}>
                    {index > 0 && <Separator />}
                    <div className="space-y-2 p-4">
                      <div className="flex items-center justify-between gap-4">
                        <div className="text-muted-foreground text-xs">{group.threadId}</div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => openThreadDialog(group.threadId)}
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

      <Dialog
        open={pendingProfileKey !== null}
        onOpenChange={(open) => {
          if (!open) setPendingProfileKey(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this memory?</DialogTitle>
            <DialogDescription>
              {displayTargetProfile
                ? `“${prettifyKey(displayTargetProfile)}” will be removed from what the assistant remembers about you. This cannot be undone.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingProfileKey(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmRemoveRow()}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingThreadId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingThreadId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete all thread summaries?</DialogTitle>
            <DialogDescription>
              {displayTargetThread
                ? `All summaries in thread ${displayTargetThread} will be removed. This cannot be undone.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingThreadId(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmRemoveThread()}>
              Delete all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

// ponytail: round-trip a stringified value back to its real shape so
// toNode sees objects/arrays instead of pre-stringified JSON. Strings
// re-pass as strings (via empty / single-quote proxy).
function parseValue(value: string): unknown {
  if (value === "") return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
