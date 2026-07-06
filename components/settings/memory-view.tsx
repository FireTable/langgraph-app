"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Loader2, ScrollText, Trash2, User } from "lucide-react";

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
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { JsonBlock } from "@/components/tool-ui/primitives/json-block";
import { CopyButton } from "@/components/ui/copy-button";
import { mergeMemory, type AuthInfo, type MemoryDoc } from "@/lib/memory/merge";
import { AUTH_OVERLAY_KEYS, type AuthOverlayKey } from "@/lib/memory/constants";
import { prettifyKey } from "@/lib/memory/format";
import type { SummaryEntry } from "@/lib/memory/validators";
import { formatSummaryText } from "@/lib/langgraph/format-summary";
import { cn } from "@/lib/utils";

// ponytail: the API returns {store, auth, threads} as separate
// fields. The UI runs the same mergeMemory the model uses on the
// system-prompt side, then classifies each merged field as
// "summarized by AI" (key present in store) vs "from account" (key
// filled only by the auth overlay). Single source of truth for
// merge logic across backend / frontend.
//
// `threadTitle` is the row from the threads table (set by
// renameThreadAgent on the first turn). Null when the rename path
// hasn't run yet — UI falls back to the raw threadId.
type MemoryResponse = {
  store: MemoryDoc;
  auth: AuthInfo;
  threads: Array<{ key: string; value: SummaryEntry; threadTitle: string | null }>;
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

// ponytail: ISO-8601 → human timestamp for the Memory tab's per-summary
// header. Kept inline (not in `lib/memory/format.ts`) so the settings
// view has no module coupling — the format is only used here.
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
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
  // ponytail: single flag covers BOTH dialogs — the per-row button
  // click and the dialog confirm can race (profile delete in flight
  // while the thread dialog opens), so a shared "is a destructive
  // op in progress?" flag prevents the user from queuing a second
  // delete while the first is still settling.
  const [deleting, setDeleting] = useState(false);

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

  // ponytail: /api/memory/profile returns summaries as a flat list ordered
  // by createdAt asc server-side. Group by threadId here so one thread with
  // N summaries renders as one block, not N.
  //
  // No client-side sort, neither on the outer thread list nor on the inner
  // summaries within a thread. Memory tab is a strict passthrough — the
  // backend's flat order is the render order:
  //   - Outer: first threadId seen in the flat list = first thread block.
  //   - Inner: insertion order into the per-thread array = backend order.
  //
  // threadTitle rides on the first entry that creates the group. Every
  // entry in the same thread carries the same title (renameThreadAgent
  // sets it once on the first turn), so first-wins is identical to
  // last-wins — using the first avoids a re-assignment loop.
  //
  // Hooks must run before any early return — calling useMemo after the
  // error/!memory guards throws "Rendered more hooks than during the
  // previous render".
  const threadGroups = useMemo(() => {
    const groups = new Map<string, { threadTitle: string | null; summaries: SummaryEntry[] }>();
    for (const entry of memory?.threads ?? []) {
      const existing = groups.get(entry.value.threadId);
      if (existing) {
        existing.summaries.push(entry.value);
      } else {
        groups.set(entry.value.threadId, {
          threadTitle: entry.threadTitle,
          summaries: [entry.value],
        });
      }
    }
    return [...groups.entries()].map(([threadId, data]) => ({
      threadId,
      threadTitle: data.threadTitle,
      summaries: data.summaries,
    }));
  }, [memory]);

  if (error) {
    return (
      <div className={cn("text-destructive p-6 text-sm", className)} role="alert">
        {error}
      </div>
    );
  }
  if (!memory) {
    // ponytail: mirror the real layout (About you + Thread summaries)
    // so the page doesn't jump when content arrives — the user sees
    // the shape of what they're waiting for, not a plain text blob.
    return (
      <div className={cn("flex w-full flex-col gap-4 md:gap-6", className)}>
        <section>
          <Skeleton className="mb-1 h-4 w-24" />
          <Skeleton className="mb-3 h-3 w-96 max-w-full" />
          <Card className="p-0">
            <CardContent className="p-0">
              {[0, 1, 2].map((i) => (
                <div key={i}>
                  {i > 0 && <Separator />}
                  <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2 px-4 py-3">
                    <Skeleton className="size-7 rounded-md" />
                    <div className="min-w-0 space-y-2">
                      <Skeleton className="h-3 w-16" />
                      <Skeleton className="h-4 w-40" />
                    </div>
                    <Skeleton className="h-8 w-16 rounded-md" />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </section>

        <section>
          <Skeleton className="mb-1 h-4 w-32" />
          <Skeleton className="mb-3 h-3 w-96 max-w-full" />
          <Card className="p-0">
            <CardContent className="p-0">
              <div>
                <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2 px-4 py-3">
                  <Skeleton className="size-7 rounded-md" />
                  <div className="min-w-0 space-y-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-20" />
                  </div>
                  <Skeleton className="h-8 w-16 rounded-md" />
                </div>
                <div className="space-y-3 px-4 pb-4 ps-[calc(theme(spacing.7)+theme(spacing.3)+theme(spacing.4))]">
                  {[0, 1].map((i) => (
                    <div key={i} className="space-y-1.5">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <Skeleton className="h-3 w-20" />
                        <Skeleton className="h-3 w-24" />
                      </div>
                      <Skeleton className="h-20 w-full rounded-md" />
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        </section>
      </div>
    );
  }

  const rows = buildRows(memory.store, memory.auth);

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
    if (!key) return;
    // ponytail: dialog stays open while the request is in flight so
    // the spinner on the destructive button is actually visible —
    // closing first would hide the loading state on the button the
    // user just clicked.
    setDeleting(true);
    try {
      await deleteProfile(key);
      setPendingProfileKey(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPendingProfileKey(null);
    } finally {
      setDeleting(false);
    }
  };
  const confirmRemoveThread = async () => {
    const threadId = pendingThreadId;
    if (!threadId) return;
    setDeleting(true);
    try {
      await deleteThread(threadId);
      setPendingThreadId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPendingThreadId(null);
    } finally {
      setDeleting(false);
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
                <div className="p-8 text-center">
                  <div className="bg-muted mx-auto mb-3 flex size-9 items-center justify-center rounded-full">
                    <Bot className="text-muted-foreground size-4" aria-hidden />
                  </div>
                  <p className="mb-1 text-sm font-medium">No profile fields yet</p>
                  <p className="text-muted-foreground mx-auto max-w-xs text-xs leading-relaxed">
                    When the assistant writes down something to remember about you, it&apos;ll show
                    up here. You can edit or delete it from there.
                  </p>
                </div>
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
          <h2 className="text-sm font-semibold mb-1">Thread summaries</h2>
          <p className="text-muted-foreground mb-3 text-xs leading-relaxed">
            Compressed recaps of past conversations, fed back into context so the assistant
            doesn&apos;t lose the thread over time.
          </p>
          {threadGroups.length === 0 ? (
            <Card className="p-0">
              <CardContent className="p-0">
                <div className="p-8 text-center">
                  <div className="bg-muted mx-auto mb-3 flex size-9 items-center justify-center rounded-full">
                    <ScrollText className="text-muted-foreground size-4" aria-hidden />
                  </div>
                  <p className="mb-1 text-sm font-medium">No thread summaries yet</p>
                  <p className="text-muted-foreground mx-auto max-w-xs text-xs leading-relaxed">
                    Once a conversation runs long enough to compress, the earlier turns get
                    summarized and land here.
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card className="p-0">
              <CardContent className="p-0">
                {threadGroups.map((group, index) => {
                  // ponytail: title preferred, raw threadId is the
                  // pre-rename fallback (renameThreadAgent runs once
                  // on the first turn — threads that predate that path
                  // never had a title written). When title IS present,
                  // the threadId still shows in muted meta under the
                  // title so a user can paste the id into a bug report
                  // without fishing it out of the URL.
                  const title = group.threadTitle ?? group.threadId;
                  const hasTitle = group.threadTitle !== null;
                  return (
                    <div key={group.threadId}>
                      {index > 0 && <Separator />}
                      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2 px-4 py-3">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              aria-label="Summarized by AI — written by your assistant during a past conversation"
                              // ponytail: distinct hint from "summarized-by-ai"
                              // so selectors that count profile rows only
                              // (e.g. /tests/frontend/settings FR-018) keep
                              // working when this thread row is added.
                              className="text-muted-foreground hover:text-foreground inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-muted"
                              data-hint="summarized-thread"
                            >
                              <ScrollText className="size-5" aria-hidden />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            Summarized by AI — written by your assistant during a past conversation.
                            You can delete this.
                          </TooltipContent>
                        </Tooltip>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{title}</div>
                          <div className="text-muted-foreground mt-0.5 text-xs">
                            {hasTitle ? group.threadId : null}
                          </div>
                        </div>
                        <Button
                          type="button"
                          className="ml-auto shrink-0"
                          variant="outline"
                          size="sm"
                          onClick={() => openThreadDialog(group.threadId)}
                          aria-label={`Delete this thread summaries for ${title}`}
                        >
                          <Trash2 aria-hidden />
                          Delete
                        </Button>
                      </div>
                      {/* ponytail: each compression is its own row under
                          the thread header, indented to the content
                          column so the Q&A reads as belonging to the
                          pass above it. Header reads "Summary · N"
                          (not "Compression #N" — "summary" reads as a
                          noun to a non-engineer, the middot matches
                          the timestamp separator that follows). The
                          sequence + timestamp together tell the user
                          which pass produced what without exposing
                          the internal counter. */}
                      <div className="space-y-3 px-4 pb-4 ps-[calc(theme(spacing.7)+theme(spacing.3)+theme(spacing.4))]">
                        {group.summaries.map((s) => (
                          <div key={`${s.threadId}:${s.sequence}`} className="space-y-1.5">
                            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                              <span className="text-muted-foreground text-xs font-medium capitalize tracking-wide">
                                Summary · {s.sequence}
                              </span>
                              <time
                                dateTime={s.createdAt}
                                className="text-muted-foreground text-xs tabular-nums"
                              >
                                · {formatTimestamp(s.createdAt)}
                              </time>
                            </div>
                            {/* ponytail: cap height so a deep summary
                                (many Q&A pairs in one compression) can't
                                push the rest of the card off-screen —
                                overflow scrolls inside the block, same
                                pattern as the JSON block in About-you. */}
                            <pre className="bg-muted/50 text-foreground overflow-auto rounded-md p-2.5 text-foreground max-h-30 overflow-y-auto whitespace-pre-wrap font-sans text-sm">
                              {formatSummaryText(s.summary.entries)}
                            </pre>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
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
            <Button
              variant="outline"
              onClick={() => setPendingProfileKey(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmRemoveRow()}
              disabled={deleting}
              aria-busy={deleting}
            >
              {deleting ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden />
                  Deleting…
                </>
              ) : (
                "Delete"
              )}
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
            <DialogTitle>Delete this thread summaries?</DialogTitle>
            <DialogDescription>
              {displayTargetThread
                ? `All summaries in thread ${displayTargetThread} will be removed. This cannot be undone.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingThreadId(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmRemoveThread()}
              disabled={deleting}
              aria-busy={deleting}
            >
              {deleting ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden />
                  Deleting…
                </>
              ) : (
                "Delete"
              )}
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
