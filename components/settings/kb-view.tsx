"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronRight, FileText, Folder, Loader2 } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// ponytail: Settings → Knowledge Base tab. Mirrors `memory-view.tsx`
// chrome (same bg-muted/30 shell, same collapsible sections, same
// shadcn primitives). Per-user scoped — the API already filters by
// userId, so the UI never sees another user's data.

type KbStatus = "pending" | "parsing" | "success" | "failed";

type KbDocument = {
  id: string;
  title: string;
  status: KbStatus;
  errorMessage: string | null;
  contentType: string;
  attachmentId: string | null;
  createdAt: string;
  updatedAt: string;
};

type KbFolder = { id: string; name: string };

type KbResponse = {
  groups: Array<{ folder: KbFolder; documents: KbDocument[] }>;
};

function StatusIcon({ status }: { status: KbStatus }) {
  switch (status) {
    case "success":
      return <CheckCircle2 className="size-5 text-green-600" aria-hidden />;
    case "failed":
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Failed — click for error message"
              className="inline-flex"
              data-hint="kb-failed"
            >
              <AlertCircle className="text-destructive size-5" aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Failed</TooltipContent>
        </Tooltip>
      );
    case "parsing":
    case "pending":
      return <Loader2 className="text-muted-foreground size-5 animate-spin" aria-hidden />;
    default:
      return <FileText className="text-muted-foreground size-5" aria-hidden />;
  }
}

function StatusLabel({ status, errorMessage }: { status: KbStatus; errorMessage: string | null }) {
  if (status === "failed") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="text-destructive text-xs font-medium tracking-wide">Failed</span>
        </TooltipTrigger>
        <TooltipContent side="top">{errorMessage ?? "Unknown error"}</TooltipContent>
      </Tooltip>
    );
  }
  const label = status === "success" ? "Ready" : status === "parsing" ? "Parsing" : "Pending";
  return (
    <span className="text-muted-foreground text-xs font-medium tracking-wide capitalize">
      {label}
    </span>
  );
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function KbView({ className }: { className?: string }) {
  const [data, setData] = useState<KbResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/kb/documents");
      if (!res.ok) {
        setError(`failed to load (${res.status})`);
        return;
      }
      setData((await res.json()) as KbResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const isEmpty = useMemo(
    () => (data?.groups ?? []).every((g) => g.documents.length === 0),
    [data],
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
      <div className={cn("flex w-full flex-col gap-4 md:gap-6", className)}>
        <Skeleton className="mb-1 h-4 w-32" />
        <Skeleton className="mb-3 h-3 w-96 max-w-full" />
        <Card className="p-0">
          <CardContent className="p-0">
            {[0, 1, 2].map((i) => (
              <div key={i}>
                {i > 0 && <Separator />}
                <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 px-4 py-3 md:grid-cols-[auto_1fr_auto]">
                  <Skeleton className="size-7 rounded-md" />
                  <div className="min-w-0 space-y-2">
                    <Skeleton className="h-3 w-24" />
                    <Skeleton className="h-4 w-40" />
                  </div>
                  <Skeleton className="h-6 w-16" />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div className={cn("flex w-full flex-col gap-4 md:gap-6", className)}>
        <section>
          <h2 className="text-sm font-semibold mb-1">Knowledge base</h2>
          <p className="text-muted-foreground mb-3 text-xs leading-relaxed">
            PDFs and other attachments you upload in chat land here as searchable documents. Drop a
            file into the composer and the assistant will use it to ground its replies.
          </p>
          {isEmpty ? (
            <Card className="p-0">
              <CardContent className="p-0">
                <div className="p-8 text-center">
                  <div className="bg-muted mx-auto mb-3 flex size-9 items-center justify-center rounded-full">
                    <Folder className="text-muted-foreground size-4" aria-hidden />
                  </div>
                  <p className="mb-1 text-sm font-medium">No documents yet</p>
                  <p className="text-muted-foreground mx-auto max-w-xs text-xs leading-relaxed">
                    Upload a file in chat to get started — it&apos;ll show up here once the
                    assistant has read it.
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : (
            data.groups.map((group) =>
              group.documents.length === 0 ? null : (
                <Card key={group.folder.id} className="mt-4 p-0">
                  <CardContent className="p-0">
                    <div className="flex items-center gap-2 px-4 pt-3 pb-2 text-muted-foreground text-xs font-semibold uppercase tracking-wide">
                      <Folder className="size-3.5" aria-hidden />
                      {group.folder.name}
                      <span className="text-muted-foreground/60 normal-case font-normal tracking-normal">
                        · {group.documents.length}
                      </span>
                    </div>
                    {group.documents.map((doc, index) => (
                      <div key={doc.id}>
                        {index > 0 && <Separator />}
                        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 px-4 py-3 md:grid-cols-[auto_1fr_auto]">
                          <StatusIcon status={doc.status} />
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium" title={doc.title}>
                              {doc.title}
                            </div>
                            <div className="text-muted-foreground mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
                              <StatusLabel status={doc.status} errorMessage={doc.errorMessage} />
                              <time dateTime={doc.createdAt} className="tabular-nums">
                                · {formatTimestamp(doc.createdAt)}
                              </time>
                            </div>
                          </div>
                          <span aria-hidden />
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              ),
            )
          )}
        </section>
      </div>
    </TooltipProvider>
  );
}

void ChevronRight;
