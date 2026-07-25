"use client";

import React from "react";
import { Activity, Bot, Calendar, Clock, Sparkles, User } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { RecentRun } from "../types";

interface LLMGenerationCardProps {
  run: RecentRun;
  onOpenTrace?: (run: RecentRun) => void;
  onRunJudge?: (run: RecentRun) => void;
  evaluating?: boolean;
}

export function LLMGenerationCard({
  run,
  onOpenTrace,
  onRunJudge,
  evaluating = false,
}: LLMGenerationCardProps) {
  const judgment = run.judgment;

  return (
    <Card className="border-border/60 bg-card/60 shadow-2xs hover:border-border transition-colors">
      <CardHeader className="p-3.5 pb-2 border-b border-border/40 bg-muted/20">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Bot className="size-4 text-primary shrink-0" />
            <span className="font-mono font-semibold text-xs text-foreground truncate">
              {run.agent}
            </span>
            <Badge variant="outline" className="font-mono text-[10px] uppercase">
              {run.variantId || "var_chat_default"}
            </Badge>
            <Badge
              variant={run.status === "success" ? "default" : "destructive"}
              className="font-mono text-[10px]"
            >
              {run.status}
            </Badge>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[11px] font-mono text-muted-foreground flex items-center gap-1">
              <Clock className="size-3" />
              {run.totalMs}ms
            </span>

            {onOpenTrace && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:text-foreground"
                title="View Observability Waterfall Trace"
                onClick={() => onOpenTrace(run)}
              >
                <Activity className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-3.5 flex flex-col gap-3">
        {/* Content details / Query snippet */}
        <div className="flex flex-col gap-1 text-xs">
          <div className="flex items-center justify-between text-muted-foreground text-[11px]">
            <span className="font-mono">Run ID: {run.id}</span>
            <span className="font-mono">{new Date(run.createdAt).toLocaleString()}</span>
          </div>

          {run.parentMessageId ? (
            <div className="bg-muted/30 p-2 rounded-md border border-border/40 font-mono text-[11px] text-muted-foreground flex items-center gap-2">
              <User className="size-3 text-primary shrink-0" />
              <span>Parent Msg ID: {run.parentMessageId}</span>
            </div>
          ) : (
            <div className="italic text-muted-foreground/60 text-[11px]">
              Standalone Agent Run (No bound HumanMessage ID)
            </div>
          )}
        </div>

        {/* AI Judge Evaluation Result Block */}
        <div className="border-t border-border/40 pt-2.5 flex items-center justify-between gap-3">
          {judgment ? (
            <div className="flex flex-col gap-1 min-w-0">
              <div className="flex items-center gap-2">
                <Sparkles className="size-3.5 text-amber-500 shrink-0" />
                <span className="text-xs font-semibold">AI Judge Assessment:</span>
                <div className="flex items-center gap-1">
                  {Object.entries(judgment.scores || {}).map(([key, val]) => (
                    <Badge key={key} variant="secondary" className="font-mono text-[10px]">
                      {key}: {val}/5★
                    </Badge>
                  ))}
                </div>
              </div>
              {judgment.reasoning && (
                <p className="text-[11px] text-muted-foreground line-clamp-2 italic">
                  "{String(judgment.reasoning)}"
                </p>
              )}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground italic flex items-center gap-1.5">
              <Sparkles className="size-3.5 text-muted-foreground/60" />
              <span>Not evaluated by AI Judge yet</span>
            </div>
          )}

          {onRunJudge && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="gap-1.5 font-medium shrink-0"
              disabled={evaluating}
              onClick={() => onRunJudge(run)}
            >
              <Sparkles className="size-3 text-amber-500" />
              <span>
                {evaluating ? "Evaluating..." : judgment ? "Re-evaluate" : "Run AI Judge"}
              </span>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
