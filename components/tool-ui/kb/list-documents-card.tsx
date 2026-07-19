"use client";

import { useState } from "react";
import { ChevronRightIcon, FileTextIcon, FolderIcon, LoaderIcon } from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";

import { CardShell, CardHeader } from "@/components/tool-ui/primitives/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { unwrapToolResult } from "@/components/tool-ui/tool-result";
import { cn } from "@/lib/utils";

import { ChunksStatusBadge, DocStatusBadge } from "./status-badge";
import type { ListDocResult, ListDocumentsFolder } from "./types";

type ListArgs = {
  folderId?: string;
  status?: string;
  titleQuery?: string;
  page?: number;
  pageSize?: number;
};

// ponytail: visible cap before the "show more" button. Matches the
// per-folder default in the search_kb chunk list so the two cards
// feel consistent in the chat thread.
const VISIBLE_DOCS_PER_FOLDER = 3;

// ponytail: two independent collapses per folder — clicking the
// header chevron toggles the whole section, "Show more" toggles
// whether the doc list shows 3 docs or the full set. Radix
// Collapsible drives both so the open/close animates (height +
// chevron rotation) instead of jumping.
function FolderSection({ folder }: { folder: ListDocumentsFolder }) {
  const [folderOpen, setFolderOpen] = useState(true);
  const [docsExpanded, setDocsExpanded] = useState(false);
  if (folder.documents.length === 0) return null;

  // ponytail: the first 3 always render in the main list; the
  // rest go into the second Collapsible so their height animates
  // in/out (rather than the main list re-rendering with a
  // different slice and the new docs popping in un-animated).
  const head = folder.documents.slice(0, VISIBLE_DOCS_PER_FOLDER);
  const tail = folder.documents.slice(VISIBLE_DOCS_PER_FOLDER);
  const hidden = tail.length;

  return (
    <Collapsible open={folderOpen} onOpenChange={setFolderOpen} className="flex flex-col gap-2">
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground group flex items-center gap-1.5 px-1 text-left text-xs font-semibold tracking-wide transition-colors">
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-200 ease-out",
            folderOpen ? "rotate-90" : "rotate-0",
          )}
          aria-hidden
        />
        <FolderIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{folder.name}</span>
        <span className="text-muted-foreground/70 ms-1 font-normal">
          · {folder.documents.length}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
        <ul className="flex flex-col gap-1.5">
          {head.map((d) => (
            <DocRow key={d.id} d={d} />
          ))}
        </ul>
        {hidden > 0 && (
          <Collapsible open={docsExpanded} onOpenChange={setDocsExpanded}>
            <CollapsibleTrigger className="text-primary hover:text-primary/80 mx-auto inline-flex items-center gap-1 px-3 py-1 text-xs font-medium transition-colors">
              <ChevronRightIcon
                className={cn(
                  "size-3 shrink-0 transition-transform duration-200 ease-out",
                  docsExpanded ? "rotate-90" : "rotate-0",
                )}
                aria-hidden
              />
              <span>
                {docsExpanded
                  ? "Show less"
                  : `Show more (+${hidden} ${hidden === 1 ? "doc" : "docs"})`}
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
              <ul className="mt-1.5 flex flex-col gap-1.5">
                {tail.map((d) => (
                  <DocRow key={d.id} d={d} />
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

// ponytail: shared per-doc row. Same chrome in the head list and
// the (collapsed) tail list, so a CSS tweak only lands in one place.
function DocRow({ d }: { d: ListDocumentsFolder["documents"][number] }) {
  return (
    <li className="border-border/60 bg-muted/30 flex flex-col gap-1.5 rounded-lg border px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        <FileTextIcon className="text-muted-foreground size-3.5 shrink-0" />
        <span className="truncate font-medium" title={d.title}>
          {d.title}
        </span>
        <time
          dateTime={d.createdAt}
          className="text-muted-foreground ms-auto shrink-0 text-[10px] tabular-nums"
          title={d.createdAt}
        >
          {formatDate(d.createdAt)}
        </time>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <DocStatusBadge
          status={d.status}
          errorMessage={d.errorMessage}
          totalPages={d.totalPages}
          successPages={d.successPages}
          failedPages={d.failedPages}
          parsingPages={d.parsingPages}
          pendingPages={d.pendingPages}
          className="text-[10px]"
        />
        <ChunksStatusBadge
          totalChunks={d.totalChunks}
          successChunks={d.successChunks}
          failedChunks={d.failedChunks}
          pendingChunks={d.pendingChunks}
          parsingChunks={d.parsingChunks}
          docStatus={d.status}
          className="text-[10px]"
        />
      </div>
    </li>
  );
}

// ponytail: per-doc date formatter. Short locale string + the
// <time dateTime> attribute carries the full ISO. Matches the
// settings DocRow's formatTimestamp shape but trimmed for the
// narrow card column.
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export const KbListDocumentsToolUI: ToolCallMessagePartComponent<ListArgs> = ({ result }) => {
  const obj = unwrapToolResult<ListDocResult>(result);
  if (!obj) {
    return (
      <CardShell data-slot="kb-list-card" maxWidthClass="max-w-2xl">
        <CardHeader
          icon={<LoaderIcon className="size-4 animate-spin" />}
          title="Listing KB documents"
        />
      </CardShell>
    );
  }
  const folders = obj.folders ?? [];
  const isEmpty = obj.empty === true || folders.every((f) => f.documents.length === 0);
  if (isEmpty) {
    return (
      <CardShell data-slot="kb-list-card" maxWidthClass="max-w-2xl">
        <CardHeader
          icon={<FileTextIcon className="size-4" />}
          title="KB is empty"
          subtitle="No documents matched the filter."
        />
      </CardShell>
    );
  }
  const totalCount = folders.reduce((sum, f) => sum + f.documents.length, 0);
  return (
    <CardShell data-slot="kb-list-card" maxWidthClass="max-w-2xl">
      <CardHeader
        icon={<FileTextIcon className="size-4" />}
        title={`KB documents · ${totalCount}${obj.total != null && obj.total !== totalCount ? ` of ${obj.total}` : ""}`}
      />
      <div className="flex flex-col gap-4">
        {folders.map((f) => (
          <FolderSection key={f.id} folder={f} />
        ))}
      </div>
    </CardShell>
  );
};
