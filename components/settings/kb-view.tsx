"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
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
  RefreshCw,
  Search,
  Trash2,
  Copy,
  Check,
  Image,
  Blocks,
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
  pages?: Array<{ pageIndex: number; imageUrl: string; markdown: string }>;
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
    <Badge
      variant={variant}
      className="inline-flex items-center gap-1 py-0.5 font-medium leading-none"
    >
      <span className="inline-flex items-center justify-center shrink-0 leading-none">
        <StatusIcon status={status} />
      </span>
      <span className="leading-none">{label}</span>
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

// ponytail: KbView is mounted by better-auth-ui's <Settings> without
// a Suspense boundary. `useSearchParams` forces a Suspense boundary
// during SSR (otherwise the entire route opts into dynamic rendering
// or Next.js throws at build time), so we split into a thin wrapper
// that supplies the boundary and an inner component that actually
// reads the param. The fallback is the same skeleton the data-load
// path renders, so the user sees no visible difference between the
// two loading states.
export function KbView({ className }: { className?: string }) {
  return (
    <Suspense fallback={<KbViewSkeleton className={className} />}>
      <KbViewContent className={className} />
    </Suspense>
  );
}

function KbViewContent({ className }: { className?: string }) {
  const searchParams = useSearchParams();
  // ponytail: chat tiles deep-link here with `?doc=<docId>` (see
  // MessageAttachmentCard). KbView only honors the param on the
  // initial selection — once the user clicks a folder, their
  // explicit choice takes over (we don't want to yank them back if
  // the URL keeps the param from a previous visit).
  const focusDocId = searchParams.get("doc");
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
      // Auto-select: prefer the folder containing the deep-linked
      // doc, then preserve the user's previous selection, then fall
      // back to the first folder with docs. `prev` always wins once
      // set so refreshes don't yank the user out of the folder they
      // clicked on.
      setSelectedFolderId((prev) => {
        if (prev && body.groups.some((g) => g.folder.id === prev)) return prev;
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
  }, [focusDocId]);

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
            focusDocId={focusDocId}
            onAddDoc={() => fileInputRef.current?.click()}
            onRefresh={load}
          />
        </div>

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
            {groups.length === 0 ? (
              <div className="py-8 px-4 text-center">
                <span className="text-[11px] text-muted-foreground/60 italic leading-normal">
                  No folders yet
                </span>
              </div>
            ) : (
              groups.map((g) => {
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
              })
            )}
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
  focusDocId,
  onAddDoc,
  onRefresh,
}: {
  group: KbResponse["groups"][number] | null;
  focusDocId: string | null;
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
          <DocTableRows docs={group.documents} focusDocId={focusDocId} onRefresh={onRefresh} />
        )}
      </CardContent>
    </Card>
  );
}

function DocTableRows({
  docs,
  focusDocId,
  onRefresh,
}: {
  docs: KbDocument[];
  focusDocId: string | null;
  onRefresh: () => Promise<void> | void;
}) {
  return (
    <div>
      {docs.map((doc, i) => (
        <div key={doc.id}>
          {i > 0 && <Separator />}
          <DocRow doc={doc} isFocused={doc.id === focusDocId} onRefresh={onRefresh} />
        </div>
      ))}
    </div>
  );
}

function DocRow({
  doc,
  isFocused,
  onRefresh,
}: {
  doc: KbDocument;
  isFocused: boolean;
  onRefresh: () => Promise<void> | void;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [reprocessOpen, setReprocessOpen] = useState(false);
  const type = doc.contentType.replace("application/", "");
  const rowRef = useRef<HTMLDivElement | null>(null);
  // ponytail: when the row is the deep-link target (?doc=<id> in
  // the URL), scroll it into view once it's mounted. The data
  // fetch + folder switch + render is async, so we wait a tick
  // before scrolling; `block: "center"` keeps it visually anchored
  // rather than glued to the top of the scroll container. Runs
  // once per focus target — `behavior: "smooth"` is fine because
  // the scroll distance is usually small (a few folders down at
  // most) and the user just opened this view from a chat tile.
  useEffect(() => {
    if (!isFocused) return;
    const t = setTimeout(() => {
      rowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 50);
    return () => clearTimeout(t);
  }, [isFocused]);
  // ponytail: in-flight ingest/processing disables the refresh button so
  // a double-click can't kick off a parallel OCR pass against the same
  // attachment (server side also returns 409, but UI guard avoids a
  // round-trip + a toast).
  const isInflight = doc.status === "pending" || doc.status === "parsing";
  const actions = (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setReprocessOpen(true)}
            disabled={isInflight}
            aria-label="Reprocess"
          >
            <RefreshCw className="size-3.5" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          {isInflight ? "Already processing" : "Reprocess"}
        </TooltipContent>
      </Tooltip>
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
    <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className="truncate">{type}</span>
      <span aria-hidden>·</span>
      <time dateTime={doc.updatedAt} className="tabular-nums">
        {formatTimestamp(doc.updatedAt)}
      </time>
      <span aria-hidden>·</span>
      <StatusBadge status={doc.status} errorMessage={doc.errorMessage} />
    </div>
  );
  return (
    <div
      ref={rowRef}
      // ponytail: the deep-link target row gets a 3s pulse so the
      // user can find the doc they just clicked from chat, then
      // settles. The pulse ring fades in and out via Tailwind's
      // built-in `animate-pulse` keyframes; `[animation-iteration-count:1]`
      // pins the cycle to a single pass (otherwise the pulse loops
      // forever). `rounded-md` matches the row's intended corner
      // radius. `bg-accent/40` stays as the resting tint after the
      // pulse ends so the row remains visually anchored.
      data-focused={isFocused || undefined}
      className={cn(
        isFocused &&
          "bg-accent/40 ring-primary/40 rounded-md ring-2 ring-inset animate-pulse [animation-iteration-count:1] [animation-duration:3s]",
      )}
    >
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
          columns exceed the row width. The actions column is `auto`
          because four icon buttons (4 × 28px + 3 × 2px gap = 118px)
          overflowed the previous fixed 84px track and overlapped the
          Status badge to the left. */}
      <div
        className="hidden md:grid md:grid-cols-[minmax(0,1fr)_auto_120px_auto_auto] md:items-center md:gap-x-3 md:px-4 md:py-3 md:text-sm"
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
      {reprocessOpen && (
        <DocReprocessDialog
          doc={doc}
          open={reprocessOpen}
          onOpenChange={setReprocessOpen}
          onReprocessed={() => {
            setReprocessOpen(false);
            void onRefresh();
          }}
        />
      )}
    </div>
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
  const [activeTab, setActiveTab] = useState<"full_markdown" | "pages" | "chunks">("full_markdown");
  const [copied, setCopied] = useState(false);

  // ponytail: React StrictMode in dev mounts every effect twice
  // (mount → unmount → mount), so without an abort controller the
  // dev preview fetch goes out 2× and the slow one wins the
  // setDetail race. Aborting the first request on cleanup cancels
  // it at the network layer — the devtools Network tab shows 1
  // cancelled request instead of 2 successful ones. Prod builds
  // don't double-invoke so this is a no-op there.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    void fetch(`/api/kb/documents/${docId}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((body: KbDocDetail) => {
        if (!controller.signal.aborted) setDetail(body);
      })
      .catch((err) => {
        // ponytail: AbortError is expected on cleanup — don't reset
        // state to null, otherwise the second mount flashes an
        // empty dialog before its fetch resolves.
        if (err?.name !== "AbortError") setDetail(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, docId]);

  const handleCopy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  const fullMarkdown = useMemo(() => {
    if (!detail) return "";
    if (detail.doc.pages && detail.doc.pages.length > 0) {
      return detail.doc.pages
        .map((p: any) => p.markdown)
        .filter((m) => typeof m === "string" && m.length > 0)
        .join("\n\n");
    }
    return detail.chunks.map((c) => c.content).join("\n\n");
  }, [detail]);

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
      <DialogContent className="max-w-4xl">
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
          <DialogDescription asChild>
            {detail ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs select-none">
                <StatusBadge status={detail.doc.status} errorMessage={detail.doc.errorMessage} />
                <span className="size-1 rounded-full bg-muted-foreground/30 shrink-0" aria-hidden />

                <Badge
                  variant="outline"
                  className="border-none bg-transparent text-muted-foreground shadow-none px-0 py-0.5 font-normal leading-none"
                >
                  <span>{detail.doc.contentType}</span>
                </Badge>

                {detail.doc.pages && detail.doc.pages.length > 0 && (
                  <>
                    <span
                      className="size-1 rounded-full bg-muted-foreground/30 shrink-0"
                      aria-hidden
                    />
                    <Badge
                      variant="outline"
                      className="border-none bg-transparent text-muted-foreground shadow-none px-0 py-0.5 font-normal leading-none"
                    >
                      <span>{detail.doc.pages.length} pages</span>
                    </Badge>
                  </>
                )}

                {detail.chunks.length > 0 && (
                  <>
                    <span
                      className="size-1 rounded-full bg-muted-foreground/30 shrink-0"
                      aria-hidden
                    />
                    <Badge
                      variant="outline"
                      className="border-none bg-transparent text-muted-foreground shadow-none px-0 py-0.5 font-normal leading-none"
                    >
                      <span>{detail.chunks.length} chunks</span>
                    </Badge>
                  </>
                )}
              </div>
            ) : (
              <div className="h-4" />
            )}
          </DialogDescription>
        </DialogHeader>

        {detail && (
          <div className="inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground w-fit shrink-0">
            <button
              onClick={() => setActiveTab("full_markdown")}
              className={cn(
                "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-xs font-semibold transition-all duration-200 h-7",
                activeTab === "full_markdown"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <FileText className="size-3.5 mr-1.5 shrink-0" />
              <span>Markdown</span>
            </button>
            <button
              onClick={() => setActiveTab("pages")}
              className={cn(
                "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-xs font-semibold transition-all duration-200 h-7",
                activeTab === "pages"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Image className="size-3.5 mr-1.5 shrink-0" />
              <span>Pages ({detail.doc.pages?.length ?? 0})</span>
            </button>
            <button
              onClick={() => setActiveTab("chunks")}
              className={cn(
                "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-xs font-semibold transition-all duration-200 h-7",
                activeTab === "chunks"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Blocks className="size-3.5 mr-1.5 shrink-0" />
              <span>Chunks ({detail.chunks.length})</span>
            </button>
          </div>
        )}

        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1 min-h-[300px] flex flex-col justify-start min-w-0">
          {loading ? (
            <div className="space-y-3 w-full flex-1">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : !detail ? (
            <p className="text-muted-foreground text-sm">Failed to load.</p>
          ) : activeTab === "full_markdown" ? (
            // Tab 1: Full Markdown
            <div className="relative flex-1 flex flex-col border rounded-xl bg-muted/10 overflow-hidden min-h-[300px]">
              <div className="flex items-center justify-between border-b px-4 py-2 bg-muted/40 shrink-0">
                <span className="text-[11px] font-semibold capitalize tracking-wider text-muted-foreground">
                  Markdown
                </span>
                {fullMarkdown && (
                  <button
                    onClick={() => handleCopy(fullMarkdown)}
                    className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-semibold text-muted-foreground hover:text-foreground hover:bg-muted rounded border bg-background transition-all"
                  >
                    {copied ? (
                      <>
                        <Check className="size-3.5 text-green-500" />
                        <span className="text-green-500 text-[10px] font-semibold">Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="size-3.5" />
                        <span className="text-[10px] font-semibold">Copy</span>
                      </>
                    )}
                  </button>
                )}
              </div>
              <div className="p-4 flex-1 overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-foreground/90 max-h-[50vh]">
                {fullMarkdown || (
                  <span className="text-muted-foreground italic">No text extracted yet.</span>
                )}
              </div>
            </div>
          ) : activeTab === "pages" ? (
            // Tab 2: Pages Contrast
            detail.doc.pages && detail.doc.pages.length > 0 ? (
              <div className="space-y-4 w-full">
                {detail.doc.pages.map((p) => {
                  const page = p as { pageIndex: number; imageUrl: string; markdown: string };
                  return (
                    <div
                      key={page.pageIndex}
                      className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm transition-all duration-200 hover:shadow-md"
                    >
                      <div className="flex items-center justify-between border-b px-4 py-2.5 bg-muted/40">
                        <span className="text-[11px] font-semibold capitalize tracking-wider text-muted-foreground">
                          Page #{page.pageIndex + 1}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4">
                        {/* Left: PDF Image (clickable for raw zoom) */}
                        <div className="flex items-start justify-center md:col-span-1">
                          <a
                            href={page.imageUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="relative block group overflow-hidden rounded-lg border bg-muted shadow-sm transition-shadow hover:shadow-md cursor-zoom-in"
                            title="Click to view full size raw page"
                          >
                            <img
                              src={page.imageUrl}
                              alt={`Page ${page.pageIndex + 1}`}
                              className="max-h-[250px] w-auto object-contain transition-transform duration-300 group-hover:scale-[1.02]"
                              loading="lazy"
                            />
                          </a>
                        </div>
                        <div className="md:col-span-2 flex flex-col justify-start">
                          {page.markdown ? (
                            <div className="whitespace-pre-wrap break-all font-sans text-xs leading-relaxed text-foreground/90 bg-muted/20 p-3 rounded-lg border min-h-[120px] max-h-[250px] overflow-y-auto">
                              {page.markdown}
                            </div>
                          ) : (
                            <div className="flex items-center justify-center min-h-[120px] bg-muted/10 rounded-lg border border-dashed text-muted-foreground text-xs italic">
                              Text extraction empty or pending...
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-muted-foreground text-xs italic text-center p-8 border border-dashed rounded-lg bg-muted/5 w-full">
                No page screenshots available for this document (e.g. legacy or non-PDF format).
              </p>
            )
          ) : (
            // Tab 3: Embed Chunks
            <div className="space-y-3 w-full">
              {detail.chunks.length === 0 ? (
                <p className="text-muted-foreground text-xs italic text-center p-8 border border-dashed rounded-lg bg-muted/5 w-full">
                  {detail.doc.status === "success"
                    ? "Embedding chunks are still being calculated in the background. They will appear here in a few moments."
                    : detail.doc.status === "failed"
                      ? "Ingestion failed — chunks not produced."
                      : "Ingestion in progress…"}
                </p>
              ) : (
                detail.chunks.map((c) => (
                  <div
                    key={c.ordinal}
                    className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm transition-all duration-200 hover:shadow-md"
                  >
                    {/* Card Header */}
                    <div className="flex items-center justify-between border-b px-4 py-2.5 bg-muted/40">
                      <span className="text-[11px] font-semibold capitalize tracking-wider text-muted-foreground">
                        Chunk #{c.ordinal + 1}
                      </span>
                      {c.entities.length > 0 && (
                        <div className="flex items-center gap-1 max-w-[60%] truncate">
                          <span className="text-[10px] text-muted-foreground shrink-0">
                            Entities:
                          </span>
                          <span
                            className="text-[10px] text-muted-foreground/80 truncate"
                            title={c.entities.join(", ")}
                          >
                            {c.entities.slice(0, 6).join(", ")}
                          </span>
                        </div>
                      )}
                    </div>
                    {/* Card Body */}
                    <div className="p-4">
                      <p className="text-xs text-foreground/90 whitespace-pre-wrap break-all leading-relaxed">
                        {c.content}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </div>
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
          <Button
            variant="ghost"
            className="w-full sm:w-auto"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            className="w-full sm:w-auto"
            onClick={() => void submit()}
            disabled={submitting}
            variant="destructive"
          >
            {submitting ? <Loader2 className="size-3.5 animate-spin" /> : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ponytail: reprocess dialog. Server returns 202 + flips the doc row's
// status back to "pending"; the existing 2s polling effect picks it up
// and the badge in the row transitions Ready → Parsing → Ready on its
// own. We surface 409 PROCESSING without a retry — the row is already
// in flight.
function DocReprocessDialog({
  doc,
  open,
  onOpenChange,
  onReprocessed,
}: {
  doc: KbDocument;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReprocessed: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/kb/documents/${doc.id}/reprocess`, { method: "POST" });
      if (res.status === 202) {
        onReprocessed();
        return;
      }
      if (res.status === 409) {
        setError("Already processing — try again when the row settles.");
        return;
      }
      if (res.status === 404) {
        setError("Document no longer exists.");
        return;
      }
      setError(`Failed (${res.status})`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [doc.id, onReprocessed]);

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
          <DialogTitle>Reprocess document?</DialogTitle>
          <DialogDescription>
            <span className="font-medium">{doc.title}</span> will be re-rendered, re-OCRed, and
            re-chunked from scratch. Existing chunks are wiped. This uses OCR + embedding API
            tokens.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-destructive text-xs">{error}</p>}
        <DialogFooter>
          <Button
            variant="ghost"
            className="w-full sm:w-auto"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button className="w-full sm:w-auto" onClick={() => void submit()} disabled={submitting}>
            {submitting ? <Loader2 className="size-3.5 animate-spin" /> : "Reprocess"}
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
          <Button
            variant="ghost"
            className="w-full sm:w-auto"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            className="w-full sm:w-auto"
            onClick={() => void submit()}
            disabled={submitting}
            variant="destructive"
          >
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
          <Button
            variant="ghost"
            className="w-full sm:w-auto"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            className="w-full sm:w-auto"
            onClick={() => void submit()}
            disabled={submitting || !name.trim()}
          >
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

// ponytail: shared by the !data branch and the Suspense fallback in
// KbView. Kept here so the two loading states are visually identical —
// switching to/from the deep-link path should never flash a different
// shape at the user.
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
                <div className="space-y-2 px-4 py-3 md:hidden">
                  <div className="flex items-start gap-2">
                    <Skeleton className="h-4 flex-1" />
                    <Skeleton className="size-7 rounded-md" />
                    <Skeleton className="size-7 rounded-md" />
                    <Skeleton className="size-7 rounded-md" />
                  </div>
                  <Skeleton className="h-3 w-3/4" />
                </div>
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
