"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { KnowledgeGraph, type KnowledgeGraphChunk } from "./knowledge-graph";

type FolderDetail = {
  folder: {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
  };
  chunks: (KnowledgeGraphChunk & { errorMessage: string | null })[];
};

// ponytail: thin dialog shell over KnowledgeGraph. Header summarises
// folder + chunk count; body delegates to the shared component with
// `skipFailedChunks` so the cross-folder rollup ignores pending /
// parsing / failed chunks (per-doc view folds them in by contrast).
export function FolderGraphDialog({
  folderId,
  folderName,
  open,
  onOpenChange,
}: {
  folderId: string;
  folderName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [detail, setDetail] = useState<FolderDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const controller = new AbortController();

    fetch(`/api/kb/folders/${folderId}`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load");
        return res.json();
      })
      .then((data) => {
        setDetail(data);
        setLoading(false);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          setLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [open, folderId]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setDetail(null);
      }}
    >
      <DialogContent className="w-[95vw] max-w-[95vw] md:w-[75vw] md:max-w-[75vw]">
        <DialogHeader className="min-w-0 max-w-3xl flex-1">
          <div className="flex items-start justify-between gap-3 min-w-0">
            <DialogTitle className="truncate min-w-0 max-w-[80%]">
              Knowledge Graph: {folderName}
            </DialogTitle>
          </div>
          <DialogDescription className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs select-none">
              <Badge
                variant="outline"
                className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase border-muted-foreground/20 rounded shadow-none py-0 px-1 bg-muted/20 shrink-0"
              >
                Folder
              </Badge>
              <span>•</span>
              <span className="uppercase text-muted-foreground font-semibold truncate max-w-[150px] sm:max-w-[250px]">
                {folderName}
              </span>
              {detail && (
                <>
                  <span>•</span>
                  <span className="uppercase text-muted-foreground font-semibold">
                    {detail.chunks.length} Chunks
                  </span>
                </>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[75vh] space-y-4 overflow-y-auto pr-1 min-h-[300px] flex flex-col justify-start min-w-0">
          {loading ? (
            <div className="space-y-3 w-full flex-1">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : !detail ? (
            <p className="text-muted-foreground text-sm">Failed to load.</p>
          ) : (
            <KnowledgeGraph
              chunks={detail.chunks}
              skipFailedChunks
              emptyMessage="No graph data available. Upload document into this folder to extract entities and relationships."
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
