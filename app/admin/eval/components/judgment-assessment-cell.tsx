"use client";

import { Activity, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { Rubric } from "@/app/admin/eval/types";

// ponytail: shared between Online Executions rows AND Benchmark Datasets
// "Last Result" column so the two surfaces render identical AI Judge
// output. Weighted-score formula, criterion badges, reasoning quote,
// and Activity-trace button all live here; callers only supply the
// data already attached to the row (judgment + rubric for weights).
function computeWeightedScore(
  scores: Record<string, number>,
  criteria: Array<{ key?: string; name?: string; weight?: number }>,
): number | null {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const c of criteria) {
    const key = c.key || c.name;
    if (!key) continue;
    const weight = c.weight ?? 0;
    if (weight <= 0) continue;
    const score = scores[key];
    if (typeof score !== "number") continue;
    weightedSum += score * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? weightedSum / totalWeight : null;
}

export type JudgmentSummary = {
  id: string;
  scores: Record<string, number>;
  reasoning: string;
  judgeThreadId?: string | null;
  judgeParentMessageId?: string | null;
};

interface JudgmentAssessmentCellProps {
  judgment: JudgmentSummary | null;
  rubric?: Rubric;
  onOpenJudgeTrace?: () => void;
}

export function JudgmentAssessmentCell({
  judgment,
  rubric,
  onOpenJudgeTrace,
}: JudgmentAssessmentCellProps) {
  if (!judgment) {
    return (
      <span className="text-muted-foreground/60 italic text-[11px]">
        Not evaluated by AI Judge yet
      </span>
    );
  }

  // ponytail: normalize the optional-but-possibly-null fields once so the
  // rest of the component can use plain boolean checks. Handles both
  // Online Executions rows (Judgment-shaped, | undefined) and Benchmark
  // Datasets rows (denormalized pick, | undefined | null).
  const judgeThreadId = judgment.judgeThreadId ?? undefined;
  const judgeParentMessageId = judgment.judgeParentMessageId ?? undefined;

  const weighted = rubric ? computeWeightedScore(judgment.scores || {}, rubric.criteria) : null;

  const canOpenTrace = Boolean(onOpenJudgeTrace && judgeThreadId && judgeParentMessageId);

  return (
    <div className="flex flex-col gap-1 bg-amber-500/5 p-2 rounded border border-amber-500/20">
      <div className="flex items-center gap-1.5 flex-wrap">
        <Sparkles className="size-3.5 text-amber-500 shrink-0" />
        <span className="font-semibold text-[11px]">AI Assessment:</span>
        {weighted !== null && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="default"
                  className="font-mono text-[10px] bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40 cursor-help"
                >
                  Score: {parseFloat(weighted.toFixed(2))}/5
                </Badge>
              </TooltipTrigger>
              <TooltipContent
                showArrow={false}
                className="font-mono text-[11px] bg-popover text-popover-foreground border border-border shadow-md"
              >
                <div className="flex flex-col gap-1">
                  <div className="text-amber-600 dark:text-amber-400 font-semibold whitespace-nowrap">
                    Score = Σ(score × weight) / Σ(weight)
                  </div>
                  {rubric?.criteria
                    .filter(
                      (c) =>
                        (c.weight ?? 0) > 0 &&
                        typeof (judgment.scores || {})[c.key || c.name || ""] === "number",
                    )
                    .map((c) => {
                      const key = c.key || c.name || "";
                      const score = (judgment.scores || {})[key] as number;
                      const weightPct = Math.round((c.weight ?? 0) * 100);
                      return (
                        <div key={key} className="flex justify-between gap-3 text-foreground/80">
                          <span>{key}</span>
                          <span>
                            {score} × {weightPct}% = {(score * (c.weight ?? 0)).toFixed(2)}
                          </span>
                        </div>
                      );
                    })}
                  <div className="border-t border-border pt-1 mt-1 flex justify-between font-semibold">
                    <span>Total</span>
                    <span>{parseFloat(weighted.toFixed(2))} / 5</span>
                  </div>
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}

        {canOpenTrace && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground ml-auto"
            title="View AI Judge Observability Trace"
            onClick={onOpenJudgeTrace}
          >
            <Activity className="size-3.5" />
          </Button>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        {Object.entries(judgment.scores || {}).map(([k, v]) => (
          <Badge key={k} variant="secondary" className="font-mono text-[10px]">
            {k}: {v}/5
          </Badge>
        ))}
      </div>

      {judgment.reasoning && (
        <p className="text-[11px] text-muted-foreground italic line-clamp-2">
          "{String(judgment.reasoning)}"
        </p>
      )}
    </div>
  );
}
