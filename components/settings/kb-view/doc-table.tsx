import { useEffect, useRef, useState } from "react";
import { ExternalLink, Network, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { KB_POLL_INTERVAL_MS } from "@/lib/constants";
import { KbResponse, KbDocument } from "./types";
import { HeaderBar } from "./folder-sidebar";
import { DocStatusBadge, ChunksStatusBadge, formatTimestamp } from "./status-badge";
import { DocDetailDialog } from "./doc-detail-dialog";
import { DocDeleteDialog, DocReprocessDialog } from "./dialogs";
import { FolderGraphDialog } from "./folder-graph-dialog";
import { LivePollIndicator } from "./live-poll-indicator";

export function DocTable({
  group,
  focusDocId,
  onAddDoc,
  onRefresh,
  isLivePolling,
}: {
  group: KbResponse["groups"][number] | null;
  focusDocId: string | null;
  onAddDoc: () => void;
  onRefresh: () => Promise<void> | void;
  isLivePolling: boolean;
}) {
  const [folderGraphOpen, setFolderGraphOpen] = useState(false);

  if (!group) {
    return (
      <Card className="p-0 w-full min-w-0 overflow-hidden">
        <CardContent className="text-muted-foreground p-8 text-center text-sm w-full min-w-0">
          Select a folder to view its documents.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="p-0 w-full min-w-0 overflow-hidden">
      <CardContent className="p-0 w-full min-w-0">
        <HeaderBar
          label={`${group.folder.name} · ${group.documents.length}`}
          action={
            <div className="flex items-center gap-1.5">
              <LivePollIndicator active={isLivePolling} intervalMs={KB_POLL_INTERVAL_MS} />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    onClick={() => setFolderGraphOpen(true)}
                    aria-label="Folder Graph"
                  >
                    <Network className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">Folder Graph</TooltipContent>
              </Tooltip>

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
            </div>
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
      <FolderGraphDialog
        folderId={group.folder.id}
        folderName={group.folder.name}
        open={folderGraphOpen}
        onOpenChange={setFolderGraphOpen}
      />
    </Card>
  );
}

export function DocTableRows({
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

export function DocRow({
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

  useEffect(() => {
    if (!isFocused) return;
    const t = setTimeout(() => {
      rowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 50);
    return () => clearTimeout(t);
  }, [isFocused]);

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
    <div className="text-muted-foreground space-y-1 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="truncate">{type}</span>
        <span aria-hidden>·</span>
        <time dateTime={doc.updatedAt} className="tabular-nums">
          {formatTimestamp(doc.updatedAt)}
        </time>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        <DocStatusBadge
          status={doc.status}
          errorMessage={doc.errorMessage}
          totalPages={doc.totalPages}
          successPages={
            doc.totalPages !== undefined
              ? doc.totalPages -
                (doc.failedPages ?? 0) -
                (doc.parsingPages ?? 0) -
                (doc.pendingPages ?? 0)
              : undefined
          }
          failedPages={doc.failedPages}
          parsingPages={doc.parsingPages}
          pendingPages={doc.pendingPages}
        />
        <ChunksStatusBadge
          totalChunks={doc.totalChunks}
          successChunks={doc.successChunks}
          failedChunks={doc.failedChunks}
          pendingChunks={doc.pendingChunks}
          parsingChunks={doc.parsingChunks}
          docStatus={doc.status}
        />
      </div>
    </div>
  );
  return (
    <div
      ref={rowRef}
      data-focused={isFocused || undefined}
      className={cn(
        isFocused &&
          "bg-accent/40 ring-primary/40 rounded-md ring-2 ring-inset animate-pulse [animation-iteration-count:1] [animation-duration:3s]",
      )}
    >
      <div className="space-y-2 px-4 py-3 text-sm md:hidden w-full min-w-0" role="row">
        <div className="flex items-center justify-between gap-2 w-full min-w-0">
          <div className="min-w-0 flex-1 truncate font-medium" title={doc.title}>
            {doc.title}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
        </div>
        <div className="w-full min-w-0">{meta}</div>
      </div>
      <div
        className="hidden md:grid md:grid-cols-[minmax(0,1fr)_auto_120px_auto_auto] md:items-center md:gap-x-3 md:px-4 md:py-3 md:text-sm"
        role="row"
      >
        <div className="flex min-w-0 items-center font-medium" title={doc.title}>
          <span className="truncate min-w-0 flex-1">{doc.title}</span>
        </div>
        <div className="text-muted-foreground flex items-center truncate text-xs">{type}</div>
        <time
          dateTime={doc.updatedAt}
          className="text-muted-foreground flex items-center truncate tabular-nums text-xs"
        >
          {formatTimestamp(doc.updatedAt)}
        </time>
        <div className="flex flex-col items-center gap-1 justify-center min-w-0">
          <DocStatusBadge
            status={doc.status}
            errorMessage={doc.errorMessage}
            totalPages={doc.totalPages}
            successPages={
              doc.totalPages !== undefined
                ? doc.totalPages -
                  (doc.failedPages ?? 0) -
                  (doc.parsingPages ?? 0) -
                  (doc.pendingPages ?? 0)
                : undefined
            }
            failedPages={doc.failedPages}
            parsingPages={doc.parsingPages}
            pendingPages={doc.pendingPages}
            className="w-[120px] justify-center"
          />
          <ChunksStatusBadge
            totalChunks={doc.totalChunks}
            successChunks={doc.successChunks}
            failedChunks={doc.failedChunks}
            pendingChunks={doc.pendingChunks}
            parsingChunks={doc.parsingChunks}
            docStatus={doc.status}
            className="w-[120px] justify-center"
          />
        </div>
        <div className="flex items-center justify-end gap-0.5">{actions}</div>
      </div>

      {previewOpen && (
        <DocDetailDialog docId={doc.id} open={previewOpen} onOpenChange={setPreviewOpen} />
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
