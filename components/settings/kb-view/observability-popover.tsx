"use client";

// ponytail: Activity icon → Popover listing every kbAgent invocation
// for this doc. Click a run → opens the singleton ObservabilitySheet
// for that (threadId, parentMessageId) pair. Each row carries its own
// threadId — chat-uploaded docs have rows on the chat thread, while
// Settings standalone rows live on the docId-derived thread. The API
// stitches them together via kb_observability.docId, so the popover
// shows the full per-doc history in one place.
//
// Why a Popover (not a Dialog / Tab inside DocDetailDialog): the
// affordance is "look up runs for this one doc" — a transient query,
// not a destination. Putting it next to RefreshCw / Search / Delete
// keeps related actions grouped. The Popover reuses shadcn Popover
// primitives so styling matches the rest of the row.
import { useEffect, useState } from "react";
import { Activity, MessageSquare, RefreshCw, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useOpenObservabilitySheet } from "@/components/observability/sheet-context";
import { getModeInfo, type ReprocessMode } from "./helpers";

type ObservabilityRun = {
  runId: string | null;
  threadId: string;
  parentMessageId: string;
  source: string;
  mode: ReprocessMode;
  createdAt: string;
};

type ObservabilityResponse = {
  doc_id: string;
  runs: ObservabilityRun[];
};

export function ObservabilityPopover({ docId }: { docId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ObservabilityResponse | null>(null);
  const openSheet = useOpenObservabilitySheet();

  // ponytail: lazy-fetch on each open — close resets state so the
  // next click re-requests. Matters after a reprocess or chat
  // upload: the user reopens the popover and expects the new run
  // to show up. Caching across opens would hide it.
  useEffect(() => {
    if (!open || data || loading) return;
    setLoading(true);
    setError(null);
    fetch(`/api/kb/documents/${docId}/observability`, { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as ObservabilityResponse;
      })
      .then((body) => {
        setData(body);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Failed to load observability");
      })
      .finally(() => {
        setLoading(false);
      });
  }, [open, data, loading, docId]);

  const handleRunClick = (run: ObservabilityRun) => {
    // ponytail: each row carries its own threadId — chat uploads
    // open against the chat thread, standalone against the
    // docId-derived thread. parentMessageId is the synthetic
    // HumanMessage id (standalone) or the user's chat msg id (chat).
    openSheet({ threadId: run.threadId, parentMessageId: run.parentMessageId });
  };

  // ponytail: reset cached state on close so the next click fires a
  // fresh /observability request — otherwise the useEffect's `data`
  // guard short-circuits and the popover reopens with stale rows.
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setData(null);
      setError(null);
      setLoading(false);
    }
    setOpen(nextOpen);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="View observability"
              data-testid="kb-doc-observability-trigger"
            >
              <Activity className="size-3.5" aria-hidden />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">View observability</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" side="bottom" className="w-80 p-0">
        <PopoverHeader className="border-b px-3 py-2">
          <PopoverTitle className="text-xs">Observability List</PopoverTitle>
        </PopoverHeader>
        <div className="max-h-80 overflow-y-auto">
          {loading ? (
            // ponytail: skeleton mirrors the real row layout so the
            // popover doesn't reflow when data arrives — same icon
            // column, same source/badge line, same time line.
            <div className="px-3 py-2.5" aria-busy="true">
              <div className="flex w-full items-start gap-2.5">
                <div className="bg-muted mt-0.5 size-3.5 shrink-0 animate-pulse rounded" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="bg-muted h-3 w-24 animate-pulse rounded" />
                    <div className="bg-muted h-3 w-12 animate-pulse rounded" />
                  </div>
                  <div className="bg-muted h-3 w-32 animate-pulse rounded" />
                </div>
              </div>
            </div>
          ) : error ? (
            <div className="text-destructive px-3 py-4 text-xs" role="alert">
              {error}
            </div>
          ) : !data || data.runs.length === 0 ? (
            <div className="text-muted-foreground px-3 py-6 text-center text-xs">
              No re-runs yet. Use the reprocess button to record one.
            </div>
          ) : (
            <ul className="divide-y">
              {data.runs.map((run, i) => {
                const Icon = sourceIcon(run.source);
                return (
                  <li key={`${run.threadId}-${run.parentMessageId}-${i}`}>
                    <button
                      type="button"
                      onClick={() => handleRunClick(run)}
                      className="hover:bg-accent flex w-full items-start gap-2.5 px-3 py-2.5 text-left text-xs"
                    >
                      <Icon
                        className="text-muted-foreground mt-0.5 size-3.5 shrink-0"
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium">{sourceLabel(run.source)}</span>
                          <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-[10px]">
                            {getModeInfo(run.mode).title}
                          </span>
                        </div>
                        <time
                          dateTime={run.createdAt}
                          className="text-muted-foreground block tabular-nums"
                        >
                          {formatTimestamp(run.createdAt)}
                        </time>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ponytail: friendly source labels. The full path doesn't write
// observability rows anymore (the kb_document row IS the event for
// initial uploads); only chunksOnly / retryFailed / retryFailedChunks
// runs land here, so source is effectively always "kb-reprocess" in
// practice — but the labels handle the other values defensively in
// case chat-path chunksOnly shows up later.
function sourceLabel(source: ObservabilityRun["source"]): string {
  switch (source) {
    case "kb-upload":
      return "Upload";
    case "kb-reprocess":
      return "Reprocess";
    case "chat":
      return "Chat upload";
  }
  return source;
}

function sourceIcon(source: ObservabilityRun["source"]) {
  switch (source) {
    case "kb-upload":
      return Upload;
    case "kb-reprocess":
      return RefreshCw;
    case "chat":
      return MessageSquare;
  }
  return Activity;
}

// ponytail: mode labels match the reprocess dialog copy so the popover
// reads as a continuation of the same vocabulary.

function formatTimestamp(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}/${pad(t.getMonth() + 1)}/${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
}
