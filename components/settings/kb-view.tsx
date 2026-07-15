"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  FileText,
  Folder,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// ponytail: Settings → Knowledge Base tab. Two-column layout:
//   - LEFT: folder list + `+` to create (modal) + `...` per row to delete
//   - RIGHT: doc table for the selected folder, with rich per-row info
//     (status, title, type, time, summary, source URL), explicit
//     magnifier + delete actions per row, and a `+` header to upload
//
// Per-user scoped at the API (withAuth + user-scoped queries).
// attachmentUrl is the source R2 public URL of the chat-uploaded file.

type KbStatus = "pending" | "parsing" | "success" | "failed";

type KbDocument = {
  id: string;
  title: string;
  status: KbStatus;
  errorMessage: string | null;
  contentType: string;
  attachmentId: string | null;
  attachmentUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

type KbFolder = { id: string; name: string };

type KbResponse = {
  groups: Array<{ folder: KbFolder; documents: KbDocument[] }>;
};

type KbDocDetail = {
  doc: KbDocument & { folderId: string; contentHash: string };
  chunks: Array<{ ordinal: number; content: string; entities: string[] }>;
};

function StatusIcon({ status }: { status: KbStatus }) {
  switch (status) {
    case "success":
      return <CheckCircle2 className="size-3" aria-hidden />;
    case "failed":
      return <AlertCircle className="size-3" aria-hidden />;
    case "parsing":
    case "pending":
      return <Loader2 className="size-3 animate-spin" aria-hidden />;
    default:
      return <FileText className="size-3" aria-hidden />;
  }
}

function StatusBadge({ status, errorMessage }: { status: KbStatus; errorMessage: string | null }) {
  const variant: "success" | "destructive" | "muted" =
    status === "success" ? "success" : status === "failed" ? "destructive" : "muted";
  const label =
    status === "success"
      ? "Ready"
      : status === "parsing"
        ? "Parsing"
        : status === "failed"
          ? "Failed"
          : "Pending";
  const chip = (
    <Badge variant={variant} className="gap-1 font-medium">
      <StatusIcon status={status} />
      {label}
    </Badge>
  );
  if (status === "failed" && errorMessage) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{chip}</TooltipTrigger>
        <TooltipContent side="top">{errorMessage}</TooltipContent>
      </Tooltip>
    );
  }
  return chip;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function KbView({ className }: { className?: string }) {
  const [data, setData] = useState<KbResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/kb/documents");
      if (!res.ok) {
        setError(`failed to load (${res.status})`);
        return;
      }
      const body = (await res.json()) as KbResponse;
      setData(body);
      // Auto-select first folder (with docs if any). Skip on re-renders
      // so the user's explicit choice persists across refreshes.
      setSelectedFolderId((prev) => {
        if (prev && body.groups.some((g) => g.folder.id === prev)) return prev;
        const firstWithDocs = body.groups.find((g) => g.documents.length > 0);
        return firstWithDocs?.folder.id ?? body.groups[0]?.folder.id ?? null;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ponytail: poll every 2s while any doc is in pending/parsing — covers
  // both chat uploads (which spawn this same flow) and Settings → Add Doc.
  // Drops back to idle once everything is settled.
  useEffect(() => {
    if (!data) return;
    const anyInflight = data.groups.some((g) =>
      g.documents.some((d) => d.status === "pending" || d.status === "parsing"),
    );
    if (!anyInflight) return;
    const t = setInterval(() => void load(), 2000);
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
          <Card className="p-0">
            <CardContent className="p-0">
              <div className="flex h-9 items-center justify-between px-4">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="size-6 rounded-md" />
              </div>
              <Separator />
              {[0, 1, 2].map((i) => (
                <div key={i}>
                  {i > 0 && <Separator />}
                  {/* Mobile skeleton */}
                  <div className="space-y-2 px-4 py-3 md:hidden">
                    <div className="flex items-start gap-2">
                      <Skeleton className="h-4 flex-1" />
                      <Skeleton className="size-7 rounded-md" />
                      <Skeleton className="size-7 rounded-md" />
                    </div>
                    <Skeleton className="h-3 w-3/4" />
                  </div>
                  {/* Desktop skeleton */}
                  <div className="hidden md:grid md:grid-cols-[minmax(0,1fr)_auto_120px_auto_84px] md:items-center md:gap-x-3 md:px-4 md:py-3">
                    <Skeleton className="h-4" />
                    <Skeleton className="h-3 w-8" />
                    <Skeleton className="h-3 w-24" />
                    <Skeleton className="h-5 w-16 rounded-full" />
                    <div className="flex justify-end gap-0.5">
                      <Skeleton className="size-7 rounded-md" />
                      <Skeleton className="size-7 rounded-md" />
                      <Skeleton className="size-7 rounded-md" />
                    </div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    );
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

        {data.groups.length === 0 ? (
          <Card className="p-0">
            <CardContent className="p-0">
              <div className="p-8 text-center">
                <div className="bg-muted mx-auto mb-3 flex size-9 items-center justify-center rounded-full">
                  <Folder className="text-muted-foreground size-4" aria-hidden />
                </div>
                <p className="mb-1 text-sm font-medium">No folders yet</p>
                <p className="text-muted-foreground mx-auto max-w-xs text-xs leading-relaxed">
                  Create your first folder to start organizing documents.
                </p>
                <Button className="mt-4" onClick={() => setNewFolderOpen(true)}>
                  <Plus className="mr-1 size-3.5" /> New folder
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="grid items-start gap-4 md:grid-cols-[260px_1fr]">
            <FolderSidebar
              groups={data.groups}
              selectedId={selectedFolderId}
              onSelect={setSelectedFolderId}
              onNewFolder={() => setNewFolderOpen(true)}
              onRefresh={load}
            />
            <DocTable
              group={selectedGroup}
              onAddDoc={() => fileInputRef.current?.click()}
              onRefresh={load}
            />
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept="application/pdf"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file && selectedGroup) {
              void handleAddDoc(file, selectedGroup.folder.id, load);
            }
            e.target.value = ""; // allow re-pick same file
          }}
        />

        <FolderNameDialog
          mode="create"
          folder={null}
          open={newFolderOpen}
          onOpenChange={setNewFolderOpen}
          onCreated={(folder) => {
            setSelectedFolderId(folder.id);
            void load();
          }}
        />
      </div>
    </TooltipProvider>
  );
}

function FolderSidebar({
  groups,
  selectedId,
  onSelect,
  onNewFolder,
  onRefresh,
}: {
  groups: KbResponse["groups"];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewFolder: () => void;
  onRefresh: () => Promise<void> | void;
}) {
  const [deleteTarget, setDeleteTarget] = useState<KbFolder | null>(null);
  const [editTarget, setEditTarget] = useState<KbFolder | null>(null);
  // ponytail: track which folder's dropdown is open so the row's
  // count number can crossfade out the same way it does on hover.
  // We tried group-data-[state=open] but the dropdown's data-state
  // propagation through Radix's portal is unreliable in our setup,
  // so we mirror the open state into a data attribute on the li
  // ourselves.
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);

  return (
    <>
      <Card className="h-fit p-0">
        <CardContent className="p-0">
          <HeaderBar
            label="Folders"
            action={
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    onClick={onNewFolder}
                    aria-label="New folder"
                  >
                    <Plus className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">New folder</TooltipContent>
              </Tooltip>
            }
          />
          <Separator />
          {/* ponytail: each folder row is a padded card-like pill that
              matches the skeleton. The list itself has px-2 so the
              rounded row backgrounds sit inset from the card edge. */}
          <ul className="space-y-0.5 p-2">
            {groups.map((g) => {
              const active = g.folder.id === selectedId;
              const menuOpen = openFolderId === g.folder.id;
              return (
                <li
                  key={g.folder.id}
                  data-menu-open={menuOpen || undefined}
                  className="group/folder relative"
                >
                  <button
                    type="button"
                    onClick={() => onSelect(g.folder.id)}
                    data-active={active || undefined}
                    className={cn(
                      "hover:bg-muted/60 data-[active=true]:bg-muted flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                      active && "font-medium",
                    )}
                  >
                    <Folder className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{g.folder.name}</span>
                    <span className="ml-auto flex items-center gap-1">
                      <span className="text-muted-foreground text-xs tabular-nums transition-opacity group-hover/folder:opacity-0 group-data-[menu-open]/folder:opacity-0 mr-2">
                        {g.documents.length}
                      </span>
                    </span>
                  </button>
                  <DropdownMenu
                    open={menuOpen}
                    onOpenChange={(o) => setOpenFolderId(o ? g.folder.id : null)}
                  >
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="absolute top-1/2 right-2 size-6 -translate-y-1/2 opacity-0 transition-opacity group-hover/folder:opacity-100 group-data-[active=true]/folder:opacity-100 group-data-[menu-open]/folder:opacity-100"
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Folder actions: ${g.folder.name}`}
                      >
                        <MoreHorizontal className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => setEditTarget(g.folder)}
                        className="hover:bg-muted focus:bg-muted flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none"
                      >
                        <Pencil className="size-3.5" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => setDeleteTarget(g.folder)}
                        // ponytail: matches thread-list delete styling
                        // (components/assistant-ui/thread-list.tsx) — red
                        // text + red-tinted background on hover/focus.
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none"
                      >
                        <Trash2 className="size-3.5 text-destructive" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <FolderDeleteDialog
        folder={deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        onDeleted={() => {
          setDeleteTarget(null);
          void onRefresh();
        }}
      />
      <FolderNameDialog
        mode="edit"
        folder={editTarget}
        open={editTarget !== null}
        onOpenChange={(o) => !o && setEditTarget(null)}
        onSaved={() => {
          setEditTarget(null);
          void onRefresh();
        }}
      />
    </>
  );
}

// ponytail: shared row chrome for the Folders sidebar header and the
// doc-table header — same padding (px-4) so the right-edge action
// (folder `+`, doc `+`) lines up with the action buttons in each
// data row. h-9 keeps the heights identical.
function HeaderBar({ label, action }: { label: string; action: React.ReactNode }) {
  return (
    <div className="flex h-9 items-center justify-between px-4">
      <span className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
        {label}
      </span>
      {action}
    </div>
  );
}

function DocTable({
  group,
  onAddDoc,
  onRefresh,
}: {
  group: KbResponse["groups"][number] | null;
  onAddDoc: () => void;
  onRefresh: () => Promise<void> | void;
}) {
  if (!group) {
    return (
      <Card className="p-0">
        <CardContent className="text-muted-foreground p-8 text-center text-sm">
          Select a folder to view its documents.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="p-0">
      <CardContent className="p-0">
        <HeaderBar
          label={`${group.folder.name} · ${group.documents.length}`}
          action={
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  onClick={onAddDoc}
                  aria-label="Add doc"
                >
                  <Plus className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">Add doc</TooltipContent>
            </Tooltip>
          }
        />
        <Separator />
        {group.documents.length === 0 ? (
          <div className="text-muted-foreground p-8 text-center text-sm">
            No documents in this folder yet. Click <Plus className="inline size-3" /> to upload a
            PDF.
          </div>
        ) : (
          <DocTableRows docs={group.documents} onRefresh={onRefresh} />
        )}
      </CardContent>
    </Card>
  );
}

function DocTableRows({
  docs,
  onRefresh,
}: {
  docs: KbDocument[];
  onRefresh: () => Promise<void> | void;
}) {
  return (
    <div>
      {docs.map((doc, i) => (
        <div key={doc.id}>
          {i > 0 && <Separator />}
          <DocRow doc={doc} onRefresh={onRefresh} />
        </div>
      ))}
    </div>
  );
}

function DocRow({ doc, onRefresh }: { doc: KbDocument; onRefresh: () => Promise<void> | void }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const type = doc.contentType.replace("application/", "");
  const actions = (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setPreviewOpen(true)}
            aria-label="Preview chunks"
          >
            <Search className="size-3.5" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Preview</TooltipContent>
      </Tooltip>
      {doc.attachmentUrl && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7" asChild>
              <a href={doc.attachmentUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-3.5" aria-hidden />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Open source</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-destructive size-7"
            onClick={() => setDeleteOpen(true)}
            aria-label="Delete doc"
          >
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Delete</TooltipContent>
      </Tooltip>
    </>
  );
  const meta = (
    <span className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className="truncate">{type}</span>
      <span aria-hidden>·</span>
      <time dateTime={doc.updatedAt} className="tabular-nums">
        {formatTimestamp(doc.updatedAt)}
      </time>
      <span aria-hidden>·</span>
      <StatusBadge status={doc.status} errorMessage={doc.errorMessage} />
    </span>
  );
  return (
    <>
      {/* Mobile: title + meta below + actions inline at bottom. */}
      <div className="space-y-2 px-4 py-3 text-sm md:hidden" role="row">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate font-medium" title={doc.title}>
            {doc.title}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
        </div>
        <div>{meta}</div>
      </div>
      {/* Desktop: 5-column grid. minmax(0, 1fr) lets the title column
          shrink below its content width — without it, 1fr has implicit
          min-size: auto and collapses to 0 when the four fixed-width
          columns exceed the row width. */}
      <div
        className="hidden md:grid md:grid-cols-[minmax(0,1fr)_auto_120px_auto_84px] md:items-center md:gap-x-3 md:px-4 md:py-3 md:text-sm"
        role="row"
      >
        {/* ponytail: flex items-center so plain-text cells share the
            same vertical center as the Badge + icon buttons. Grid
            items-center only aligns the cell box, not the text inside
            a bare div — text baseline sits above the cell's geometric
            center. */}
        <div className="flex min-w-0 items-center truncate font-medium" title={doc.title}>
          {doc.title}
        </div>
        <div className="text-muted-foreground flex items-center truncate text-xs">{type}</div>
        <time
          dateTime={doc.updatedAt}
          className="text-muted-foreground flex items-center truncate tabular-nums text-xs"
        >
          {formatTimestamp(doc.updatedAt)}
        </time>
        <div className="flex items-center">
          <StatusBadge status={doc.status} errorMessage={doc.errorMessage} />
        </div>
        <div className="flex items-center justify-end gap-0.5">{actions}</div>
      </div>

      {previewOpen && (
        <DocDetailDialog
          docId={doc.id}
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          onRefresh={onRefresh}
        />
      )}
      {deleteOpen && (
        <DocDeleteDialog
          doc={doc}
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          onDeleted={() => {
            setDeleteOpen(false);
            void onRefresh();
          }}
        />
      )}
    </>
  );
}

function DocDetailDialog({
  docId,
  open,
  onOpenChange,
  onRefresh,
}: {
  docId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRefresh: () => Promise<void> | void;
}) {
  const [detail, setDetail] = useState<KbDocDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    void fetch(`/api/kb/documents/${docId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((body: KbDocDetail) => setDetail(body))
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
  }, [open, docId]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          setDetail(null);
          void onRefresh();
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <div className="flex items-start justify-between gap-3">
            <DialogTitle className="truncate">{detail?.doc.title ?? "Loading…"}</DialogTitle>
            {detail?.doc.attachmentUrl && (
              <Button asChild size="sm" variant="outline" className="shrink-0 gap-1.5">
                <a href={detail.doc.attachmentUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="size-3.5" />
                  Open source
                </a>
              </Button>
            )}
          </div>
          <DialogDescription>
            {detail && (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <StatusBadge status={detail.doc.status} errorMessage={detail.doc.errorMessage} />
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground">{detail.doc.contentType}</span>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground">{detail.chunks.length} chunks</span>
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
          {loading ? (
            <Skeleton className="h-32 w-full" />
          ) : !detail ? (
            <p className="text-muted-foreground text-sm">Failed to load.</p>
          ) : detail.chunks.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {detail.doc.status === "success"
                ? "No chunks."
                : detail.doc.status === "failed"
                  ? "Ingestion failed — chunks not produced."
                  : "Ingestion in progress…"}
            </p>
          ) : (
            detail.chunks.map((c) => (
              <div key={c.ordinal} className="rounded-md border p-3 text-xs">
                <div className="text-muted-foreground mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wide">
                  <span>#{c.ordinal}</span>
                  {c.entities.length > 0 && (
                    <span className="truncate">· {c.entities.slice(0, 6).join(", ")}</span>
                  )}
                </div>
                <p className="text-foreground/90 whitespace-pre-wrap">{c.content}</p>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DocDeleteDialog({
  doc,
  open,
  onOpenChange,
  onDeleted,
}: {
  doc: KbDocument;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/kb/documents/${doc.id}`, { method: "DELETE" });
      if (res.status === 204) {
        onDeleted();
        return;
      }
      if (res.status === 404) {
        setError("Already deleted");
        return;
      }
      setError(`Failed (${res.status})`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [doc.id, onDeleted]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setError(null);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete document?</DialogTitle>
          <DialogDescription>
            This permanently removes <span className="font-medium">{doc.title}</span> and all of its
            parsed chunks. The source file stays in R2 (v3 retention sweep will clean those up).
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-destructive text-xs">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={submitting} variant="destructive">
            {submitting ? <Loader2 className="size-3.5 animate-spin" /> : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FolderDeleteDialog({
  folder,
  onOpenChange,
  onDeleted,
}: {
  folder: KbFolder | null;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset on folder change.
  useEffect(() => {
    setError(null);
  }, [folder]);

  const submit = useCallback(async () => {
    if (!folder) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/kb/folders/${folder.id}`, { method: "DELETE" });
      if (res.status === 204) {
        onDeleted();
        return;
      }
      if (res.status === 404) {
        onDeleted(); // already gone — treat as success
        return;
      }
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { docCount?: number };
        setError(
          `Folder still has ${body.docCount ?? "some"} document${body.docCount === 1 ? "" : "s"} — delete them first.`,
        );
        return;
      }
      setError(`Failed (${res.status})`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [folder, onDeleted]);

  return (
    <Dialog
      open={folder !== null}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setError(null);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete folder?</DialogTitle>
          <DialogDescription>
            This permanently removes the <span className="font-medium">{folder?.name}</span> folder.
            Folders that still contain documents can&apos;t be deleted — empty the folder first.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-destructive text-xs">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={submitting} variant="destructive">
            {submitting ? <Loader2 className="size-3.5 animate-spin" /> : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FolderNameDialog({
  mode,
  folder,
  open,
  onOpenChange,
  onCreated,
  onSaved,
}: {
  mode: "create" | "edit";
  folder: KbFolder | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (folder: KbFolder) => void;
  onSaved?: (folder: KbFolder) => void;
}) {
  const [name, setName] = useState(folder?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // ponytail: reset the input when the dialog reopens with a new
  // folder (edit target) or after a create. Using a useEffect on
  // `open` ensures the input tracks the latest folder prop without
  // coupling to the parent's onCreated callback.
  useEffect(() => {
    if (open) {
      setName(folder?.name ?? "");
      setError(null);
    }
  }, [open, folder?.name, folder?.id]);

  const submit = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "create") {
        const res = await fetch("/api/kb/folders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        });
        if (res.status === 201) {
          const body = (await res.json()) as { folder: KbFolder };
          onCreated?.(body.folder);
          setName("");
          onOpenChange(false);
          return;
        }
        if (res.status === 409) {
          setError("A folder with this name already exists");
          return;
        }
        setError(`Failed (${res.status})`);
      } else {
        if (!folder) {
          setError("No folder to edit");
          return;
        }
        const res = await fetch(`/api/kb/folders/${folder.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        });
        if (res.status === 200) {
          const body = (await res.json()) as { folder: KbFolder };
          onSaved?.(body.folder);
          onOpenChange(false);
          return;
        }
        if (res.status === 409) {
          setError("A folder with this name already exists");
          return;
        }
        setError(`Failed (${res.status})`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [mode, folder, name, onCreated, onSaved, onOpenChange]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setError(null);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "New folder" : "Edit folder"}</DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Group your knowledge base documents by topic or project."
              : "Rename this folder. Documents inside keep their content."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="kb-folder-name">Name</Label>
          <Input
            id="kb-folder-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Project Research"
            maxLength={64}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && !submitting) void submit();
            }}
          />
          {error && <p className="text-destructive text-xs">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={submitting || !name.trim()}>
            {submitting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : mode === "create" ? (
              "Create"
            ) : (
              "Save"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ponytail: reuses the existing R2 presign → PUT → confirm flow (same
// as chat attachments). sha256 is computed client-side so the kb-level
// contentHash dedup catches re-uploads of the same file. After confirm,
// POSTs to /api/kb/upload which creates the kb_document row + fires a
// LangGraph run to ingest the file. The polling effect above picks up
// the new row + status flips.
async function sha256Hex(file: File): Promise<string | undefined> {
  try {
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return undefined;
  }
}

async function handleAddDoc(file: File, folderId: string, onRefresh: () => Promise<void> | void) {
  try {
    const sha = await sha256Hex(file);
    const presignRes = await fetch("/api/attachments/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: file.name,
        contentType: file.type,
        sizeBytes: file.size,
        ...(sha ? { sha256: sha } : {}),
      }),
    });
    if (!presignRes.ok) throw new Error(`presign failed: ${presignRes.status}`);
    const presign = (await presignRes.json()) as {
      id: string;
      uploadUrl: string;
      uploadHeaders: Record<string, string>;
      publicUrl: string;
      skipUpload?: boolean;
    };

    if (!presign.skipUpload) {
      const putRes = await fetch(presign.uploadUrl, {
        method: "PUT",
        headers: presign.uploadHeaders,
        body: file,
      });
      if (!putRes.ok) throw new Error(`upload failed: ${putRes.status}`);

      const confirmRes = await fetch(`/api/attachments/${presign.id}/confirm`, { method: "POST" });
      if (!confirmRes.ok) throw new Error(`confirm failed: ${confirmRes.status}`);
    }

    const uploadRes = await fetch("/api/kb/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderId, attachmentId: presign.id, title: file.name }),
    });
    if (!uploadRes.ok && uploadRes.status !== 202) {
      throw new Error(`kb upload failed: ${uploadRes.status}`);
    }
    void onRefresh();
  } catch (err) {
    console.error("Add Doc failed", err);
  }
}
