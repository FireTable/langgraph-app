"use client";

import React from "react";
import { CheckCircle2, ThumbsDown, ThumbsUp, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
        <table className="w-full text-left text-xs">
          <thead className="bg-muted/50 border-b text-muted-foreground font-medium uppercase text-[10px]">
            <tr>
              <th className="px-4 py-3">Run ID</th>
              <th className="px-4 py-3">Agent Node</th>
              <th className="px-4 py-3">Variant</th>
              <th className="px-4 py-3 text-center">Status</th>
              <th className="px-4 py-3 text-right">Latency</th>
              <th className="px-4 py-3 text-center">User Rating</th>
              <th className="px-4 py-3 text-center">AI Judge Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {recentRuns.map((run) => (
              <tr key={run.id} className="hover:bg-muted/20 transition-colors">
                <td className="px-4 py-3 font-mono text-[11px] font-medium text-foreground">
                  {run.id}
                </td>
                <td className="px-4 py-3 font-mono text-muted-foreground">{run.agent}</td>
                <td className="px-4 py-3">
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {run.label || run.variantId}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-center">
                  {run.status === "success" ? (
                    <span className="inline-flex items-center gap-1 text-emerald-500 font-medium text-[11px]">
                      <CheckCircle2 className="size-3" /> success
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-rose-500 font-medium text-[11px]">
                      <XCircle className="size-3" /> {run.status}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums">{run.totalMs} ms</td>
                <td className="px-4 py-3 text-center font-medium">
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
                </td>
                <td className="px-4 py-3 text-center">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => onTriggerJudge(run.id)}
                    disabled={evaluating}
                  >
                    {evaluating ? "Scoring..." : "Run AI judge"}
                  </Button>
                </td>
                <td className="px-4 py-3 text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => onOpenTraceDetail(run.id)}
                  >
                    View trace
                  </Button>
                </td>
              </tr>
            ))}
            {recentRuns.length === 0 && (
              <tr>
                <td colSpan={8} className="text-muted-foreground px-4 py-8 text-center text-xs">
                  No execution runs recorded yet. Invocations will log latency and tokens here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
