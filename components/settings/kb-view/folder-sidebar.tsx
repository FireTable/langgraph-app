import { useState } from "react";
import { Folder, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { KbResponse, KbFolder } from "./types";
import { FolderDeleteDialog, FolderNameDialog } from "./dialogs";

// ponytail: shared row chrome for the Folders sidebar header and the
// doc-table header — same padding (px-4) so the right-edge action
// (folder `+`, doc `+`) lines up with the action buttons in each
// data row. h-9 keeps the heights identical.
export function HeaderBar({ label, action }: { label: string; action: React.ReactNode }) {
  return (
    <div className="flex h-9 items-center justify-between px-4 py-2 bg-muted/30">
      <span className="text-[11px] font-semibold capitalize tracking-wider text-muted-foreground">
        {label}
      </span>
      {action}
    </div>
  );
}

export function FolderSidebar({
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
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);

  // ponytail: mirror folder selection onto ?folder=<id> so refreshing
  // the page (or sharing the URL) lands back on the same folder.
  // replaceState (not pushState) — folder switching is a sub-state of
  // the page, not a history step worth a back-button entry.
  const handleSelect = (id: string) => {
    onSelect(id);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (url.searchParams.get("folder") === id) return;
      url.searchParams.set("folder", id);
      window.history.replaceState(window.history.state, "", url.toString());
    }
  };

  return (
    <>
      <Card className="h-fit p-0 w-full min-w-0 overflow-hidden">
        <CardContent className="p-0 w-full min-w-0">
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
                      onClick={() => handleSelect(g.folder.id)}
                      data-active={active || undefined}
                      className={cn(
                        "hover:bg-muted/60 data-[active=true]:bg-muted flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                        active && "font-medium",
                      )}
                    >
                      <Folder className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
                      <span className="truncate">{g.folder.name}</span>
                      <span className="ml-auto flex items-center gap-1">
                        {/* ponytail: `g.folder.docCount` is set for
                            every folder regardless of scope — the
                            route issues a cheap COUNT for scoped-
                            out folders so the sidebar can show
                            "ArcBlock · 3" everywhere, not just on
                            the selected folder. */}
                        {(g.folder.docCount ?? 0) > 0 && (
                          <span className="text-muted-foreground text-xs tabular-nums transition-opacity group-hover/folder:opacity-0 group-data-[menu-open]/folder:opacity-0 mr-2">
                            {g.folder.docCount}
                          </span>
                        )}
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
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
        onDeleted={() => {
          void onRefresh();
        }}
      />
      <FolderNameDialog
        mode="edit"
        folder={editTarget}
        open={editTarget !== null}
        onOpenChange={(o) => {
          if (!o) setEditTarget(null);
        }}
        onSaved={() => {
          void onRefresh();
        }}
      />
    </>
  );
}

// ponytail: shared table skeleton — KbViewSkeleton (cold load) and
// DocTable (in-flight folder switch) both render this so the two
// loading paths look identical. Lives here (not in doc-table.tsx)
// to avoid a doc-table ↔ kb-view import cycle.
export function DocTableSkeleton() {
  return (
    <Card className="p-0">
      <CardContent className="p-0">
        <div className="flex h-9 items-center justify-between px-4">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="size-6 rounded-md" />
        </div>
        <Separator />
        {[0].map((i) => (
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
  );
}
