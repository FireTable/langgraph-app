"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { KB_POLL_INTERVAL_MS } from "@/lib/constants";
import { ObservabilitySheet } from "@/components/observability/sheet";
import { ObservabilitySheetProvider } from "@/components/observability/sheet-context";
import { KbResponse } from "./types";
import { DocTableSkeleton, FolderSidebar } from "./folder-sidebar";
import { DocTable } from "./doc-table";
import { FolderNameDialog } from "./dialogs";
import { AddDocDialog } from "./add-doc-dialog";

export function KbView({ className }: { className?: string }) {
  // ponytail: KB doc rows open the singleton ObservabilitySheet via the
  // same context the chat thread uses. Provider + sheet are mounted at
  // the KbView root so any DocRow (or future descendants) can call
  // useOpenObservabilitySheet() without each subtree wiring its own.
  return (
    <ObservabilitySheetProvider>
      <Suspense fallback={<KbViewSkeleton className={className} />}>
        <KbViewContent className={className} />
      </Suspense>
      <ObservabilitySheet />
    </ObservabilitySheetProvider>
  );
}

function KbViewContent({ className }: { className?: string }) {
  const searchParams = useSearchParams();
  const focusDocId = searchParams.get("doc");
  const initialFolderId = searchParams.get("folder");
  const [data, setData] = useState<KbResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(initialFolderId);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [addDocOpen, setAddDocOpen] = useState(false);
  const [isLivePolling, setIsLivePolling] = useState(false);
  // ponytail: distinct from `data` being null on cold-load — this
  // tracks the in-flight fetch for the *currently selected* folder.
  // DocTable shows a skeleton only when the current `data` is stale
  // (different folderId than the one selected). Polling + user-action
  // refreshes are optimistic — they keep showing the previous data +
  // the isLivePolling indicator pulsing, so the table never flashes
  // to a skeleton mid-session.
  //
  // ponytail: `loadedFor` remembers which folderId the current
  // `data` was fetched for. We can't use `data?.groups.find(id)` to
  // detect staleness — the API returns ALL folders in the sidebar
  // payload, just with empty `documents` for the scoped-out ones,
  // so find() always resolves to a group even after a switch.
  const [folderLoading, setFolderLoading] = useState(false);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  // ponytail: `load` is the bare fetch. Callers wrap it for the
  // UX they want — explicit user-triggered loads set folderLoading
  // first, polling calls it bare (no loading state flicker).
  const load = useCallback(async () => {
    try {
      // ponytail: scope the payload to the currently-selected folder —
      // the sidebar still gets the full folder list, but only the
      // selected folder's documents are populated (other folders
      // return `documents: []`). Cuts the JOIN cost on the KB-doc
      // list query, and lets `anyInflight` stay scoped to the
      // folder the user is actually looking at.
      const qs = selectedFolderId ? `?folderId=${encodeURIComponent(selectedFolderId)}` : "";
      const res = await fetch(`/api/kb/documents${qs}`);
      if (!res.ok) {
        setError(`failed to load (${res.status})`);
        return;
      }
      const body = (await res.json()) as KbResponse;
      setData(body);
      // ponytail: remember which folder this payload is for. Used by
      // the loading prop below to tell "data is for the selected
      // folder" (optimistic) apart from "data is stale, new fetch
      // in flight" (skeleton). Null on cold load.
      setLoadedFor(selectedFolderId);
      setSelectedFolderId((prev) => {
        if (prev && body.groups.some((g) => g.folder.id === prev)) return prev;
        // ponytail: ?folder=<id> from the URL outranks the
        // doc-derived heuristic on cold-load — refreshing a deep
        // link lands on the requested folder, not on the folder
        // owning the focus doc. Falls through to focusDocId only
        // when the URL didn't pin a folder.
        if (initialFolderId && body.groups.some((g) => g.folder.id === initialFolderId)) {
          return initialFolderId;
        }
        if (focusDocId) {
          const owning = body.groups.find((g) => g.documents.some((d) => d.id === focusDocId));
          if (owning) return owning.folder.id;
        }
        const firstWithDocs = body.groups.find((g) => g.documents.length > 0);
        return firstWithDocs?.folder.id ?? body.groups[0]?.folder.id ?? null;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [focusDocId, initialFolderId, selectedFolderId]);

  // ponytail: explicit user-triggered load (folder switch, manual
  // refresh). Toggles folderLoading so DocTable can swap to a
  // skeleton when the new group isn't available. The auto-poll
  // interval calls bare `load` so it never flashes a skeleton.
  const loadWithSkeleton = useCallback(async () => {
    setFolderLoading(true);
    try {
      await load();
    } finally {
      setFolderLoading(false);
    }
  }, [load]);

  // ponytail: after any "reprocess" / "delete" / "upload" action we
  // brute-force polling for a short window (~12s — covers the worst
  // case of "kbAgent gets dispatched → wipe commits → fire-and-forget
  // chunk INSERT lands 1-5s later"). Without this window the table's
  // `anyInflight` heuristic can race: the wipe returns success/failed
  // with totalChunks=0 BEFORE kbAgent has had a chance to INSERT the
  // new chunks, so 0 > 0+0 is false and the polling timer stops —
  // table then stays on "No Chunks" forever (until the user clicks
  // Preview or refresh).
  const recentlyDispatchedUntilRef = useRef<number>(0);
  const markRecentlyDispatched = useCallback(() => {
    recentlyDispatchedUntilRef.current = Date.now() + 12_000;
  }, []);
  // wraps `load` so any caller using it as `onRefresh` automatically
  // primes the post-dispatch polling window. DocDetailDialog /
  // DocTable / FolderSidebar all keep their existing onRefresh wiring.
  const loadWithHeartbeat = useCallback(async () => {
    markRecentlyDispatched();
    await load();
  }, [load, markRecentlyDispatched]);

  useEffect(() => {
    void loadWithSkeleton();
    // ponytail: re-fetch when the user switches folders. The API
    // payload is scoped via `?folderId=<id>`, so the doc table on
    // the right side lands on the new folder's data without us
    // having to do any client-side filtering. `loadWithSkeleton`
    // toggles folderLoading so DocTable swaps to the shared
    // DocTableSkeleton while waiting; auto-poll below uses bare
    // `load` to keep the table optimistic.
  }, [loadWithSkeleton]);

  useEffect(() => {
    if (!data) return;
    // ponytail: keep polling while EITHER the doc-row status is in
    // flight OR any chunk is still pending/parsing inside an
    // otherwise-success doc. OCR finalises (status flips to "success")
    // well before chunks finish their embedding + entity-extract pass,
    // so the original "doc.status === pending|parsing" check froze
    // the badge on "Indexing" until the user opened the detail dialog
    // (which has its own /api/kb/documents/[id] polling) and missed
    // the table-level refresh entirely.
    const anyInflight = data.groups.some((g) =>
      g.documents.some(
        (d) =>
          d.status === "pending" ||
          d.status === "parsing" ||
          (d.totalChunks ?? 0) > (d.successChunks ?? 0) + (d.failedChunks ?? 0) ||
          ((d.totalChunks ?? 0) == 0 && (d.totalPages ?? 0) > 0),
      ),
    );

    // brute-force window after a Reprocess/Upload/Delete dispatch so
    // the wipe→INSERT race doesn't strand the table on stale counts.
    const inDispatchWindow = Date.now() < recentlyDispatchedUntilRef.current;
    if (!anyInflight && !inDispatchWindow) {
      setIsLivePolling(false);
      return;
    }
    setIsLivePolling(true);
    // ponytail: if polling is sustained only by the post-dispatch
    // window (no in-flight docs to drive it), schedule a state flip
    // so the live indicator turns off when the window expires.
    if (!anyInflight && inDispatchWindow) {
      const ms = recentlyDispatchedUntilRef.current - Date.now();
      const t = setTimeout(() => setIsLivePolling(false), ms);
      return () => clearTimeout(t);
    }
    const t = setInterval(() => void load(), KB_POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [data, load]);

  const selectedGroup = useMemo(
    () => data?.groups.find((g) => g.folder.id === selectedFolderId) ?? null,
    [data, selectedFolderId],
  );

  if (error) {
    return (
      <div className={cn("text-destructive p-6 text-sm", className)} role="alert">
        {error}
      </div>
    );
  }

  if (!data) {
    return <KbViewSkeleton className={className} />;
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div className={cn("flex w-full flex-col gap-4", className)}>
        <section>
          <h2 className="text-sm font-semibold mb-1">Knowledge base</h2>
          <p className="text-muted-foreground mb-3 text-xs leading-relaxed">
            PDFs and other attachments you upload in chat land here as searchable documents. Drop a
            file into the composer and the assistant will use it to ground its replies.
          </p>
        </section>

        <div className="grid items-start gap-4 md:grid-cols-[260px_1fr] w-full min-w-0">
          <FolderSidebar
            groups={data.groups}
            selectedId={selectedFolderId}
            onSelect={setSelectedFolderId}
            onNewFolder={() => setNewFolderOpen(true)}
            onRefresh={loadWithHeartbeat}
          />
          <DocTable
            group={selectedGroup}
            focusDocId={focusDocId}
            onAddDoc={() => setAddDocOpen(true)}
            onRefresh={loadWithHeartbeat}
            isLivePolling={isLivePolling}
            // ponytail: skeleton fires only when the in-flight fetch
            // is for a *different* folder than the one currently
            // rendered. Cold load (loadedFor=null) + folder switch
            // (loadedFor !== selectedFolderId) both qualify. Polling
            // and user-action refreshes keep showing the previous
            // data with the isLivePolling indicator pulsing.
            loading={folderLoading && loadedFor !== selectedFolderId}
          />
        </div>

        <AddDocDialog
          open={addDocOpen}
          onOpenChange={setAddDocOpen}
          folderId={selectedGroup?.folder.id ?? null}
          onSuccess={loadWithHeartbeat}
        />

        <FolderNameDialog
          mode="create"
          folder={null}
          open={newFolderOpen}
          onOpenChange={setNewFolderOpen}
          onCreated={(folder) => {
            setSelectedFolderId(folder.id);
            void loadWithHeartbeat();
          }}
        />
      </div>
    </TooltipProvider>
  );
}

function KbViewSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("flex w-full flex-col gap-4", className)}>
      <div className="flex flex-col gap-3">
        <Skeleton className="mb-1 h-4 w-32" />
        <Skeleton className="mb-3 h-3 w-96 max-w-full" />
      </div>
      <div className="grid items-start gap-4 md:grid-cols-[260px_1fr]">
        <Card className="h-fit p-0">
          <CardContent className="p-0">
            <div className="flex h-9 items-center justify-between px-4">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="size-6 rounded-md" />
            </div>
            <Separator />
            <div className="space-y-0.5 p-2">
              {[0, 1].map((i) => (
                <Skeleton key={i} className="h-7 rounded-md" />
              ))}
            </div>
          </CardContent>
        </Card>
        <DocTableSkeleton />
      </div>
    </div>
  );
}

// ponytail: shared table skeleton — used by KbViewSkeleton for
// cold-load and by DocTable for in-flight folder-switch reloads,
// so the two paths render the same row shape. Single source of
// truth keeps the visual consistent.
// (DocTableSkeleton itself lives in folder-sidebar.tsx — shared
// between KbViewSkeleton here and DocTable's loading branch
// without creating a doc-table ↔ kb-view cycle.)
