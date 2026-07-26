"use client";

import React from "react";
import { Bot, Clock, Code2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { RunTraceDetail } from "../types";

interface TraceDetailDialogProps {
  runId: string | null;
  onOpenChange: (open: boolean) => void;
  loading: boolean;
  traceDetail: RunTraceDetail | null;
  onTriggerJudge: (runId: string) => void;
  evaluating: boolean;
}

export function TraceDetailDialog({
  runId,
  onOpenChange,
  loading,
  traceDetail,
  onTriggerJudge,
  evaluating,
}: TraceDetailDialogProps) {
  return (
    <Dialog open={Boolean(runId)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="size-4 text-primary" /> Execution Run Trace Detail
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">Run ID: {runId}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="py-8 text-center text-muted-foreground text-xs animate-pulse">
            Loading trace context & spans...
          </div>
        ) : traceDetail ? (
          <div className="flex flex-col gap-4 text-xs max-h-[480px] overflow-y-auto pr-1">
            <div className="grid grid-cols-3 gap-2 bg-muted/40 p-3 rounded-lg font-mono">
              <div>
                <span className="text-[10px] text-muted-foreground block uppercase">
                  Agent Node
                </span>
                <span className="font-semibold text-foreground">{traceDetail.run.agent}</span>
              </div>
              <div>
                <span className="text-[10px] text-muted-foreground block uppercase">Variant</span>
                <span className="font-semibold text-foreground">
                  {traceDetail.run.label || traceDetail.run.variantId}
                </span>
              </div>
              <div>
                <span className="text-[10px] text-muted-foreground block uppercase">
                  Total Latency
                </span>
                <span className="font-semibold text-foreground">
                  {(traceDetail.run.totalMs / 1000).toFixed(2)} s
                </span>
              </div>
            </div>

            {traceDetail.judgment ? (
              <div className="bg-primary/5 border border-primary/20 rounded-lg p-3 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-primary flex items-center gap-1.5">
                    <Bot className="size-4" /> AI Judge Score Result
                  </span>
                  <Badge variant="default" className="font-mono text-xs">
                    {traceDetail.judgment.scores.overall ?? 85} / 100
                  </Badge>
                </div>
                <p className="text-muted-foreground text-xs leading-relaxed">
                  {traceDetail.judgment.reasoning}
                </p>
              </div>
            ) : (
              <div className="flex items-center justify-between bg-muted/30 border border-dashed rounded-lg p-3">
                <span className="text-muted-foreground text-xs">
                  AI Judge scoring not triggered for this run yet.
                </span>
                <Button
                  size="xs"
                  onClick={() => runId && onTriggerJudge(runId)}
                  disabled={evaluating}
                >
                  {evaluating ? "Evaluating..." : "Run AI judge"}
                </Button>
              </div>
            )}

            <Separator />

            <div className="flex flex-col gap-2">
              <span className="font-semibold text-foreground flex items-center gap-1.5">
                <Code2 className="size-4 text-primary" /> Execution Spans (
                {traceDetail.spans?.length || 0})
              </span>
              <div className="flex flex-col gap-1.5">
                {traceDetail.spans?.map((span) => (
                  <div
                    key={span.id}
                    className="flex items-center justify-between bg-muted/20 border p-2 rounded-md font-mono text-[11px]"
                  >
                    <span>{span.name}</span>
                    <span className="text-muted-foreground">{span.durationMs} ms</span>
                  </div>
                ))}
                {(!traceDetail.spans || traceDetail.spans.length === 0) && (
                  <div className="text-muted-foreground italic text-xs py-2">
                    No explicit span sub-steps recorded.
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
