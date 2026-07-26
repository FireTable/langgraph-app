"use client";

import React, { useEffect, useState } from "react";
import {
  Activity,
  Bot,
  ChevronDown,
  Edit3,
  FlaskConical,
  Play,
  Plus,
  RotateCw,
  Scale,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { AgentGroupCard } from "../components/agent-group-card";
import { LLMGenerationCard } from "../components/llm-generation-card";
import { Judgment, LANGGRAPH_GROUPS, RecentRun, Rubric, Variant } from "../types";
import { AddBenchmarkDialog } from "./add-benchmark-dialog";
import { EditRubricDialog } from "./edit-rubric-dialog";

export type BenchmarkItem = {
  id: string;
  agent: string;
  title: string;
  inputPrompt: string;
  expectedOutput?: string | null;
  createdAt: string;
};

// ponytail: weighted score = Σ(score × weight) / Σ(weight). Returns null
// when the rubric lacks positive weights or no scored criterion matches
// a rubric key — the renderer falls back to the per-criterion badges.
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

interface AgentBenchmarkTabProps {
  recentRuns: RecentRun[];
  rubrics: Rubric[];
  judgments: Judgment[];
  variants: Variant[];
  collapsedGroups: Record<string, boolean>;
  toggleGroupCollapse: (groupId: string) => void;
  onOpenTrace: (run: RecentRun) => void;
  onRunJudge: (run: RecentRun) => Promise<void>;
  onRefresh: () => void;
}

export function AgentBenchmarkTab({
  recentRuns,
  rubrics,
  judgments,
  variants,
  collapsedGroups,
  toggleGroupCollapse,
  onOpenTrace,
  onRunJudge,
  onRefresh,
}: AgentBenchmarkTabProps) {
  const [collapsedAgents, setCollapsedAgents] = useState<Record<string, boolean>>({});
  const [benchmarks, setBenchmarks] = useState<BenchmarkItem[]>([]);
  const [loadingBenchmarks, setLoadingBenchmarks] = useState(false);

  // Independent row loading states (No global full-page lock)
  const [evaluatingRunIds, setEvaluatingRunIds] = useState<Set<string>>(new Set());
  const [testingBenchmarkIds, setTestingBenchmarkIds] = useState<Set<string>>(new Set());

  // Dialog States
  const [editRubricTarget, setEditRubricTarget] = useState<{
    id: string;
    name: string;
    criteria: Array<{ key: string; description: string; weight?: number }>;
  } | null>(null);
  const [addBenchmarkTarget, setAddBenchmarkTarget] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [savingRubric, setSavingRubric] = useState(false);
  const [submittingBenchmark, setSubmittingBenchmark] = useState(false);

  const fetchBenchmarks = async () => {
    setLoadingBenchmarks(true);
    try {
      const res = await fetch("/api/eval/benchmarks");
      if (res.ok) {
        const data = await res.json();
        setBenchmarks(data.benchmarks || []);
      }
    } catch {
      // Ignore
    } finally {
      setLoadingBenchmarks(false);
    }
  };

  useEffect(() => {
    fetchBenchmarks();
  }, []);

  const toggleAgentCollapse = (agentId: string) => {
    setCollapsedAgents((prev) => ({ ...prev, [agentId]: !prev[agentId] }));
  };

  const handleSaveRubric = async (
    criteria: Array<{ key: string; description: string; weight?: number }>,
  ) => {
    if (!editRubricTarget) return;
    setSavingRubric(true);
    try {
      const res = await fetch("/api/eval/benchmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_rubric",
          rubricId: `rubric_${editRubricTarget.id}`,
          agent: editRubricTarget.id,
          name: `${editRubricTarget.name} Evaluation Rubric`,
          criteria,
        }),
      });
      if (!res.ok) throw new Error("Failed to update rubric");
      toast.success("Rubric criteria updated successfully");
      onRefresh();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Error saving rubric");
    } finally {
      setSavingRubric(false);
    }
  };

  const handleAddBenchmark = async (data: {
    agent: string;
    title: string;
    inputPrompt: string;
    expectedOutput?: string;
  }) => {
    setSubmittingBenchmark(true);
    try {
      const res = await fetch("/api/eval/benchmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", ...data }),
      });
      if (!res.ok) throw new Error("Failed to add benchmark case");
      toast.success(`Benchmark "${data.title}" added`);
      fetchBenchmarks();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Error adding benchmark");
    } finally {
      setSubmittingBenchmark(false);
    }
  };

  const handleDeleteBenchmark = async (id: string) => {
    try {
      const res = await fetch("/api/eval/benchmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", id }),
      });
      if (!res.ok) throw new Error("Failed to delete benchmark");
      toast.success("Benchmark deleted");
      fetchBenchmarks();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Error deleting benchmark");
    }
  };

  const handleRunEvaluate = async (bm: BenchmarkItem) => {
    setTestingBenchmarkIds((prev) => new Set(prev).add(bm.id));
    try {
      const res = await fetch("/api/eval/benchmarks/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ benchmarkId: bm.id }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      const data = (await res.json()) as { runId?: string };
      toast.success(
        `Evaluation completed for "${bm.title}"${data.runId ? ` (run ${data.runId})` : ""}`,
      );
      onRefresh();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Evaluation failed");
    } finally {
      setTestingBenchmarkIds((prev) => {
        const next = new Set(prev);
        next.delete(bm.id);
        return next;
      });
    }
  };

  const handleSingleJudge = async (run: RecentRun) => {
    setEvaluatingRunIds((prev) => new Set(prev).add(run.id));
    try {
      await onRunJudge(run);
    } finally {
      setEvaluatingRunIds((prev) => {
        const next = new Set(prev);
        next.delete(run.id);
        return next;
      });
    }
  };

  const judgmentsByRunId = new Map<string, Judgment>();
  for (const j of judgments) {
    judgmentsByRunId.set(j.runId, j);
  }

  const enrichedRuns = recentRuns.map((r) => ({
    ...r,
    judgment: r.judgment || judgmentsByRunId.get(r.id),
  }));

  // ponytail: pre-index rubrics by agent so the row renderer can O(1)
  // look up weights for the weighted-score computation. Without this the
  // existing render path was already paying O(rubrics) per row, which
  // gets noticeable once the platform logs hundreds of runs.
  const rubricByAgent = new Map<string, Rubric>();
  for (const r of rubrics) {
    const agentKey = (r as { agent?: string }).agent ?? r.id.replace(/^rubric_/, "");
    rubricByAgent.set(agentKey, r);
  }

  const defaultRubric = rubrics.find((r) => r.id === "rubric_default") || {
    id: "rubric_default",
    name: "Default Agent Rubric",
    criteria: [
      { key: "relevance", description: "Answer addresses user query accurately." },
      { key: "accuracy", description: "Answer is factually correct." },
    ],
  };

  return (
    <div className="flex flex-col gap-8">
      {/* SECTION 1: Top Overview & Controls */}
      <section className="flex flex-col gap-3.5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold">Agent Benchmark & Evaluation Studio</h3>
            <p className="text-muted-foreground text-xs mt-0.5">
              Manage per-Agent evaluation Rubrics, Benchmark Datasets, and Execution Traces.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="gap-1.5 font-medium"
              onClick={onRefresh}
            >
              <RotateCw className="size-3.5 text-primary" />
              <span>Refresh Executions</span>
            </Button>
          </div>
        </div>

        {/* Evaluation Summary Stats Header Card */}
        <Card className="border-border/80 shadow-2xs bg-card/60 p-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="flex flex-col gap-1 border-r border-border/40 pr-4">
              <span className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wider">
                Total Executions Logged
              </span>
              <span className="text-2xl font-bold font-mono">{enrichedRuns.length}</span>
            </div>
            <div className="flex flex-col gap-1 border-r border-border/40 pr-4">
              <span className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wider">
                AI Judgments Completed
              </span>
              <span className="text-2xl font-bold font-mono text-amber-500">
                {enrichedRuns.filter((r) => r.judgment).length}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wider">
                Benchmark Dataset Cases
              </span>
              <span className="text-2xl font-bold font-mono text-primary font-mono">
                {benchmarks.length} Test Cases
              </span>
            </div>
          </div>
        </Card>
      </section>

      <Separator />

      {/* SECTION 2: Agent Group Accordions & Execution Log Cards */}
      <section className="flex flex-col gap-6">
        {LANGGRAPH_GROUPS.map((group) => {
          const Icon = group.icon;
          const isGroupCollapsed = collapsedGroups[group.id];

          return (
            <AgentGroupCard
              key={group.id}
              id={group.id}
              label={group.label}
              description={group.description}
              icon={Icon}
              isCollapsed={isGroupCollapsed}
              onToggleCollapse={() => toggleGroupCollapse(group.id)}
            >
              <div className="flex flex-col gap-6">
                {group.agents.map((agentObj) => {
                  const agentId = agentObj.id;
                  const isAgentCollapsed = collapsedAgents[agentId];
                  // Filter runs, benchmarks, and rubric strictly belonging to this agent node
                  const agentRuns = enrichedRuns.filter((r) => r.agent === agentObj.id);
                  const agentBenchmarks = benchmarks.filter((b) => b.agent === agentId);
                  const agentRubric = rubrics.find(
                    (r) => (r as any).agent === agentId || r.id === `rubric_${agentId}`,
                  ) || {
                    id: `rubric_${agentId}`,
                    name: `${agentObj.name} Evaluation Rubric`,
                    criteria: [
                      { key: "relevance", description: "Answer addresses user query accurately." },
                      { key: "accuracy", description: "Answer is factually correct." },
                    ],
                  };

                  return (
                    <div
                      key={agentId}
                      className="border border-border/60 rounded-xl overflow-hidden bg-background/50"
                    >
                      {/* Agent Header Bar */}
                      <div className="py-2 px-4 bg-muted/30 border-b border-border/40 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-6 text-muted-foreground hover:text-foreground shrink-0"
                            onClick={() => toggleAgentCollapse(agentId)}
                          >
                            <ChevronDown
                              className={`size-3.5 transition-transform duration-200 ${
                                isAgentCollapsed ? "-rotate-90" : "rotate-0"
                              }`}
                            />
                          </Button>
                          <span className="font-semibold text-foreground font-mono text-xs">
                            <Badge className="font-mono capitalize">{agentId}</Badge>
                          </span>
                        </div>
                        <span className="text-muted-foreground font-normal text-xs">
                          {agentObj.desc}
                        </span>
                      </div>

                      {/* Agent Body Content */}
                      {!isAgentCollapsed && (
                        <div className="p-4 flex flex-col gap-4">
                          {/* Rubric Criteria Table */}
                          <div className="border border-border/60 rounded-lg overflow-hidden bg-card">
                            <div className="p-2.5 bg-muted/40 border-b border-border/40 flex items-center justify-between text-xs font-semibold">
                              <div className="flex items-center gap-2">
                                <Scale className="size-4 text-amber-500" />
                                <span>Rubric Evaluation Criteria</span>
                              </div>
                              <Button
                                type="button"
                                variant="outline"
                                size="xs"
                                className="gap-1 font-medium"
                                onClick={() =>
                                  setEditRubricTarget({
                                    id: agentId,
                                    name: agentObj.name,
                                    criteria: agentRubric.criteria.map((c: any) => ({
                                      key: c.key || c.name || "criterion",
                                      description: c.description || "",
                                      weight: c.weight ?? 0.5,
                                    })),
                                  })
                                }
                              >
                                <Edit3 className="size-3" /> Edit Rubric
                              </Button>
                            </div>

                            <table className="w-full text-left text-xs border-collapse table-fixed">
                              <colgroup>
                                <col className="w-[220px]" />
                                <col className="w-[100px]" />
                                <col />
                              </colgroup>
                              <thead>
                                <tr className="border-b border-border/40 bg-muted/20 text-muted-foreground font-mono text-[11px]">
                                  <th className="py-2.5 px-3 font-medium">CRITERION KEY</th>
                                  <th className="py-2.5 px-3 font-medium">WEIGHT</th>
                                  <th className="py-2.5 px-3 font-medium">
                                    JUDGE GUIDELINE & DESCRIPTION
                                  </th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-border/30 font-sans">
                                {agentRubric.criteria.map((c, i) => {
                                  const name =
                                    ("key" in c ? c.key : (c as any).name) || "criterion";
                                  const desc = c.description || "-";
                                  const weight = c.weight ? `${Math.round(c.weight * 100)}%` : "-";

                                  return (
                                    <tr
                                      key={name || i}
                                      className="hover:bg-muted/10 transition-colors"
                                    >
                                      <td className="py-2 px-3 font-mono font-semibold text-amber-600 dark:text-amber-400">
                                        {name}
                                      </td>
                                      <td className="py-2 px-3 font-mono text-muted-foreground">
                                        {weight}
                                      </td>
                                      <td className="py-2 px-3 text-muted-foreground leading-relaxed">
                                        {desc}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>

                          {/* Sub Tabs: Execution History vs Benchmark Datasets */}
                          <Tabs defaultValue="executions" className="w-full">
                            <TabsList className="h-9 bg-muted/40 p-1 rounded-lg">
                              <TabsTrigger value="executions" className="text-xs px-3 gap-1">
                                <Activity className="size-3 text-primary" /> Online Executions (
                                {agentRuns.length})
                              </TabsTrigger>
                              <TabsTrigger value="benchmarks" className="text-xs px-3 gap-1">
                                <FlaskConical className="size-3 text-muted-foreground" /> Benchmark
                                Datasets ({agentBenchmarks.length})
                              </TabsTrigger>
                            </TabsList>

                            {/* TAB 1: Benchmark Dataset Table */}
                            <TabsContent value="benchmarks" className="flex flex-col gap-3">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-semibold text-muted-foreground">
                                  Pre-defined Benchmark Test Suite
                                </span>
                                <Button
                                  type="button"
                                  variant="default"
                                  size="xs"
                                  className="gap-1.5 font-medium"
                                  onClick={() =>
                                    setAddBenchmarkTarget({ id: agentId, name: agentObj.name })
                                  }
                                >
                                  <Plus className="size-3.5" /> Add Test Case
                                </Button>
                              </div>

                              {agentBenchmarks.length === 0 ? (
                                <div className="py-8 text-center text-muted-foreground italic text-xs border border-dashed rounded-lg bg-muted/10">
                                  No benchmark dataset cases created for {agentObj.name} yet. Click
                                  "+ Add Test Case" to create one.
                                </div>
                              ) : (
                                <div className="border border-border/60 rounded-lg overflow-hidden bg-card">
                                  <table className="w-full text-left text-xs border-collapse table-fixed">
                                    <colgroup>
                                      <col className="w-[220px]" />
                                      <col />
                                      <col className="w-[180px]" />
                                    </colgroup>
                                    <thead>
                                      <tr className="border-b border-border/40 bg-muted/20 text-muted-foreground font-mono text-[11px]">
                                        <th className="py-2.5 px-3 font-medium">TEST CASE & ID</th>
                                        <th className="py-2.5 px-3 font-medium">
                                          INPUT PROMPT & EXPECTED GROUND TRUTH
                                        </th>
                                        <th className="py-2.5 px-3 font-medium text-right">
                                          ACTIONS
                                        </th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-border/30 font-sans">
                                      {agentBenchmarks.map((bm) => (
                                        <tr
                                          key={bm.id}
                                          className="hover:bg-muted/10 transition-colors"
                                        >
                                          <td className="py-3 px-3 align-middle">
                                            <div className="flex flex-col gap-1">
                                              <span className="font-semibold text-foreground">
                                                {bm.title}
                                              </span>
                                              <span className="font-mono text-[10px] text-muted-foreground">
                                                {bm.id}
                                              </span>
                                            </div>
                                          </td>
                                          <td className="py-3 px-3 align-middle">
                                            <div className="flex flex-col gap-1 text-xs">
                                              <div className="font-mono bg-muted/30 p-1.5 rounded border border-border/40 text-foreground">
                                                Input: {bm.inputPrompt}
                                              </div>
                                              {bm.expectedOutput && (
                                                <div className="text-muted-foreground/80 italic text-[11px]">
                                                  Expected: {bm.expectedOutput}
                                                </div>
                                              )}
                                            </div>
                                          </td>
                                          <td className="py-3 px-3 align-middle text-right">
                                            <div className="flex items-center justify-end gap-1.5">
                                              <Button
                                                type="button"
                                                variant="outline"
                                                size="xs"
                                                disabled={testingBenchmarkIds.has(bm.id)}
                                                className="gap-1 font-medium text-amber-600 dark:text-amber-400 hover:text-amber-500"
                                                onClick={() => handleRunEvaluate(bm)}
                                              >
                                                {testingBenchmarkIds.has(bm.id) ? (
                                                  <RotateCw className="size-3 animate-spin text-amber-500" />
                                                ) : (
                                                  <Sparkles className="size-3 text-amber-500" />
                                                )}
                                                <span>
                                                  {testingBenchmarkIds.has(bm.id)
                                                    ? "Running…"
                                                    : "Run Evaluate"}
                                                </span>
                                              </Button>
                                              <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                className="size-7 text-muted-foreground hover:text-rose-500"
                                                onClick={() => handleDeleteBenchmark(bm.id)}
                                              >
                                                <Trash2 className="size-3.5" />
                                              </Button>
                                            </div>
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </TabsContent>

                            {/* TAB 2: Online Executions Table */}
                            <TabsContent value="executions" className="flex flex-col gap-3">
                              {agentRuns.length === 0 ? (
                                <div className="py-8 text-center text-muted-foreground italic text-xs border border-dashed rounded-lg bg-muted/10">
                                  No LLM executions logged for {agentObj.name} yet. Trigger a run in
                                  Chat to evaluate.
                                </div>
                              ) : (
                                <div className="border border-border/60 rounded-lg overflow-hidden bg-card">
                                  <table className="w-full text-left text-xs border-collapse table-fixed">
                                    <colgroup>
                                      <col className="w-[100px]" />
                                      <col />
                                      <col className="w-[140px]" />
                                    </colgroup>
                                    <thead>
                                      <tr className="border-b border-border/40 bg-muted/20 text-muted-foreground font-mono text-[11px]">
                                        <th className="py-2.5 px-3 font-medium">CONTEXT</th>
                                        <th className="py-2.5 px-3 font-medium">
                                          AI JUDGE ASSESSMENT
                                        </th>
                                        <th className="py-2.5 px-3 font-medium text-right">
                                          ACTIONS
                                        </th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-border/30 font-sans">
                                      {agentRuns.map((run) => {
                                        const judgment = run.judgment;
                                        const isEvaluating = evaluatingRunIds.has(run.id);

                                        return (
                                          <tr
                                            key={run.id}
                                            className="hover:bg-muted/10 transition-colors"
                                          >
                                            <td className="py-3 px-3 align-middle">
                                              {run.threadId && run.parentMessageId ? (
                                                <Button
                                                  type="button"
                                                  variant="outline"
                                                  size="xs"
                                                  className="gap-1.5 font-mono text-[11px] w-fit"
                                                  title="View Execution Observability Trace"
                                                  onClick={() => onOpenTrace(run)}
                                                >
                                                  <Activity className="size-3" />
                                                  Context
                                                </Button>
                                              ) : (
                                                <span className="text-muted-foreground/40 text-[11px]">
                                                  —
                                                </span>
                                              )}
                                            </td>

                                            <td className="py-3 px-3 align-middle">
                                              {judgment ? (
                                                <div className="flex flex-col gap-1 bg-amber-500/5 p-2 rounded border border-amber-500/20">
                                                  <div className="flex items-center gap-1.5 flex-wrap">
                                                    <Sparkles className="size-3.5 text-amber-500 shrink-0" />
                                                    <span className="font-semibold text-[11px]">
                                                      AI Assessment:
                                                    </span>
                                                    {(() => {
                                                      const rubric = rubricByAgent.get(run.agent);
                                                      if (!rubric) return null;
                                                      const weighted = computeWeightedScore(
                                                        judgment.scores || {},
                                                        rubric.criteria,
                                                      );
                                                      if (weighted === null) return null;
                                                      return (
                                                        <TooltipProvider>
                                                          <Tooltip>
                                                            <TooltipTrigger asChild>
                                                              <Badge
                                                                variant="default"
                                                                className="font-mono text-[10px] bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40 cursor-help"
                                                              >
                                                                Score:{" "}
                                                                {parseFloat(weighted.toFixed(2))}/5
                                                              </Badge>
                                                            </TooltipTrigger>
                                                            <TooltipContent
                                                              showArrow={false}
                                                              className="font-mono text-[11px] bg-popover text-popover-foreground border border-border shadow-md"
                                                            >
                                                              <div className="flex flex-col gap-1">
                                                                <div className="text-amber-600 dark:text-amber-400 font-semibold whitespace-nowrap">
                                                                  Score = Σ(score × weight) /
                                                                  Σ(weight)
                                                                </div>
                                                                {rubric.criteria
                                                                  .filter(
                                                                    (c) =>
                                                                      (c.weight ?? 0) > 0 &&
                                                                      typeof (judgment.scores ||
                                                                        {})[
                                                                        c.key || c.name || ""
                                                                      ] === "number",
                                                                  )
                                                                  .map((c) => {
                                                                    const key =
                                                                      c.key || c.name || "";
                                                                    const score =
                                                                      (judgment.scores || {})[
                                                                        key
                                                                      ] as number;
                                                                    const weightPct = Math.round(
                                                                      (c.weight ?? 0) * 100,
                                                                    );
                                                                    return (
                                                                      <div
                                                                        key={key}
                                                                        className="flex justify-between gap-3 text-foreground/80"
                                                                      >
                                                                        <span>{key}</span>
                                                                        <span>
                                                                          {score} × {weightPct}% ={" "}
                                                                          {(
                                                                            score * (c.weight ?? 0)
                                                                          ).toFixed(2)}
                                                                        </span>
                                                                      </div>
                                                                    );
                                                                  })}
                                                                <div className="border-t border-border pt-1 mt-1 flex justify-between font-semibold">
                                                                  <span>Total</span>
                                                                  <span>
                                                                    {parseFloat(
                                                                      weighted.toFixed(2),
                                                                    )}{" "}
                                                                    / 5
                                                                  </span>
                                                                </div>
                                                              </div>
                                                            </TooltipContent>
                                                          </Tooltip>
                                                        </TooltipProvider>
                                                      );
                                                    })()}
                                                    {Object.entries(judgment.scores || {}).map(
                                                      ([k, v]) => (
                                                        <Badge
                                                          key={k}
                                                          variant="secondary"
                                                          className="font-mono text-[10px]"
                                                        >
                                                          {k}: {v}/5
                                                        </Badge>
                                                      ),
                                                    )}
                                                  </div>
                                                  {judgment.reasoning && (
                                                    <p className="text-[11px] text-muted-foreground italic line-clamp-2">
                                                      "{String(judgment.reasoning)}"
                                                    </p>
                                                  )}
                                                </div>
                                              ) : (
                                                <span className="text-muted-foreground/60 italic text-[11px]">
                                                  Not evaluated by AI Judge yet
                                                </span>
                                              )}
                                            </td>

                                            <td className="py-3 px-3 align-middle text-right">
                                              <div className="flex items-center justify-end gap-1.5">
                                                {judgment?.judgeThreadId &&
                                                  judgment?.judgeParentMessageId && (
                                                    <Button
                                                      type="button"
                                                      variant="ghost"
                                                      size="icon"
                                                      className="size-7 text-muted-foreground hover:text-foreground"
                                                      title="View AI Judge Observability Trace"
                                                      onClick={() =>
                                                        onOpenTrace({
                                                          ...run,
                                                          threadId: judgment.judgeThreadId!,
                                                          parentMessageId:
                                                            judgment.judgeParentMessageId!,
                                                        })
                                                      }
                                                    >
                                                      <Activity className="size-3.5" />
                                                    </Button>
                                                  )}

                                                <Button
                                                  type="button"
                                                  variant="outline"
                                                  size="xs"
                                                  className="gap-1.5 font-medium shrink-0"
                                                  disabled={isEvaluating}
                                                  onClick={() => handleSingleJudge(run)}
                                                >
                                                  <Sparkles className="size-3 text-amber-500" />
                                                  <span>
                                                    {isEvaluating
                                                      ? "Evaluating..."
                                                      : judgment
                                                        ? "Re-evaluate"
                                                        : "Evaluate"}
                                                  </span>
                                                </Button>
                                              </div>
                                            </td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </TabsContent>
                          </Tabs>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </AgentGroupCard>
          );
        })}
      </section>

      {/* Modals */}
      {editRubricTarget && (
        <EditRubricDialog
          key={editRubricTarget.id}
          open={!!editRubricTarget}
          onOpenChange={(o) => !o && setEditRubricTarget(null)}
          agentId={editRubricTarget.id}
          agentName={editRubricTarget.name}
          initialCriteria={editRubricTarget.criteria}
          onSave={handleSaveRubric}
          saving={savingRubric}
        />
      )}

      {addBenchmarkTarget && (
        <AddBenchmarkDialog
          open={!!addBenchmarkTarget}
          onOpenChange={(o) => !o && setAddBenchmarkTarget(null)}
          agentId={addBenchmarkTarget.id}
          agentName={addBenchmarkTarget.name}
          onAdd={handleAddBenchmark}
          submitting={submittingBenchmark}
        />
      )}
    </div>
  );
}
