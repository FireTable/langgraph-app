"use client";

import React from "react";
import { Activity, CheckCircle2, ThumbsDown, ThumbsUp, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useOpenObservabilitySheet } from "@/components/observability/sheet-context";
import { RecentRun } from "../types";

interface ExecutionLogsTabProps {
  recentRuns: RecentRun[];
  onTriggerJudge: (runId: string) => void;
  evaluating: boolean;
  onOpenTraceDetail: (runId: string) => void;
}

export function ExecutionLogsTab({
  recentRuns,
  onTriggerJudge,
  evaluating,
  onOpenTraceDetail,
}: ExecutionLogsTabProps) {
  const openSheet = useOpenObservabilitySheet();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">Execution Traces & AI Judge Trigger</h3>
          <p className="text-muted-foreground text-xs mt-0.5">
            Inspect live evaluation run traces, input/output messages, token consumption, and
            trigger LLM-as-a-Judge scoring.
          </p>
        </div>
        <Badge variant="secondary" className="font-mono text-xs">
          {recentRuns.length} Total Run Logs
        </Badge>
      </div>

      <div className="border-border/80 overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xs">
        <Table className="text-xs">
          <TableHeader className="bg-muted/50 uppercase text-[10px]">
            <TableRow>
              <TableHead>Run ID</TableHead>
              <TableHead>Agent Node</TableHead>
              <TableHead>Variant</TableHead>
              <TableHead className="text-center">Status</TableHead>
              <TableHead className="text-right">Latency</TableHead>
              <TableHead className="text-center">User Rating</TableHead>
              <TableHead className="text-center">AI Judge Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {recentRuns.map((run) => (
              <TableRow key={run.id}>
                <TableCell className="font-mono text-[11px] font-medium text-foreground">
                  {run.id}
                </TableCell>
                <TableCell className="font-mono text-muted-foreground">{run.agent}</TableCell>
                <TableCell>
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {run.label || run.variantId}
                  </Badge>
                </TableCell>
                <TableCell className="text-center">
                  {run.status === "success" ? (
                    <span className="inline-flex items-center gap-1 text-emerald-500 font-medium text-[11px]">
                      <CheckCircle2 className="size-3" /> success
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-rose-500 font-medium text-[11px]">
                      <XCircle className="size-3" /> {run.status}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {run.totalMs} ms
                </TableCell>
                <TableCell className="text-center font-medium">
                  {run.userRating === 5 ? (
                    <span className="inline-flex items-center gap-1 text-emerald-500 bg-emerald-500/10 px-1.5 py-0.5 rounded-full text-[10px]">
                      <ThumbsUp className="size-3" /> 5 (Up)
                    </span>
                  ) : run.userRating === 1 ? (
                    <span className="inline-flex items-center gap-1 text-rose-500 bg-rose-500/10 px-1.5 py-0.5 rounded-full text-[10px]">
                      <ThumbsDown className="size-3" /> 1 (Down)
                    </span>
                  ) : run.userRating ? (
                    <span className="text-amber-500 font-mono">{run.userRating} ★</span>
                  ) : (
                    <span className="text-muted-foreground/50">—</span>
                  )}
                </TableCell>
                <TableCell className="text-center">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => onTriggerJudge(run.id)}
                    disabled={evaluating}
                  >
                    {evaluating ? "Scoring..." : "Run AI judge"}
                  </Button>
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-foreground"
                    title="Open Observability Spans"
                    onClick={() => {
                      openSheet({
                        threadId: run.threadId || run.id,
                        parentMessageId: run.parentMessageId ?? null,
                      });
                    }}
                  >
                    <Activity className="size-4 text-primary" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {recentRuns.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="text-muted-foreground px-4 py-8 text-center text-xs"
                >
                  No execution runs recorded yet. Invocations will log latency and tokens here.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
