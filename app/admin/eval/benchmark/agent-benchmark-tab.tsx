"use client";

import React, { useState } from "react";
import {
  Activity,
  Bot,
  ChevronDown,
  ChevronRight,
  Play,
  RotateCw,
  Scale,
  Sparkles,
  Sliders,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { AgentGroupCard } from "../components/agent-group-card";
import { LLMGenerationCard } from "../components/llm-generation-card";
import { Judgment, LANGGRAPH_GROUPS, RecentRun, Rubric, Variant } from "../types";

interface AgentBenchmarkTabProps {
  recentRuns: RecentRun[];
  rubrics: Rubric[];
  judgments: Judgment[];
  variants: Variant[];
  collapsedGroups: Record<string, boolean>;
  toggleGroupCollapse: (groupId: string) => void;
  onOpenTrace: (run: RecentRun) => void;
  onRunJudge: (run: RecentRun) => void;
  onRefresh: () => void;
  evaluating?: boolean;
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
  evaluating = false,
}: AgentBenchmarkTabProps) {
  // Collapsible Agent Nodes state
  const [collapsedAgents, setCollapsedAgents] = useState<Record<string, boolean>>({});

  const toggleAgentCollapse = (agentId: string) => {
    setCollapsedAgents((prev) => ({ ...prev, [agentId]: !prev[agentId] }));
  };

  // Map judgments into recentRuns for quick access
  const judgmentsByRunId = new Map<string, Judgment>();
  for (const j of judgments) {
    judgmentsByRunId.set(j.runId, j);
  }

  const enrichedRuns = recentRuns.map((r) => ({
    ...r,
    judgment: r.judgment || judgmentsByRunId.get(r.id),
  }));

  const defaultRubric = rubrics.find((r) => r.id === "rubric_default") || {
    id: "rubric_default",
    name: "Default Agent Rubric",
    criteria: [
      { key: "accuracy", description: "Answer is factually correct." },
      { key: "relevance", description: "Answer addresses user query accurately." },
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
              LLM Generations and AI-as-a-Judge evaluations organized per Agent Graph node.
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
                Active Rubric Rules
              </span>
              <span className="text-2xl font-bold font-mono text-primary">
                {defaultRubric.criteria.length} Criteria
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

                  // Filter runs belonging strictly to this agent node
                  const agentRuns = enrichedRuns.filter((r) => r.agent === agentObj.id);

                  return (
                    <div
                      key={agentId}
                      className="border border-border/60 rounded-xl overflow-hidden bg-background/50"
                    >
                      {/* Agent Header Bar */}
                      <div className="p-3.5 bg-muted/30 border-b border-border/40 flex items-center justify-between gap-3">
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
                            {agentObj.name} ({agentId})
                          </span>
                          <span className="text-muted-foreground font-normal text-xs border-l pl-2 hidden sm:inline">
                            {agentObj.desc}
                          </span>
                        </div>

                        <div className="flex items-center gap-2">
                          <Badge variant="secondary" className="font-mono text-[10px]">
                            {agentRuns.length} Executions
                          </Badge>
                        </div>
                      </div>

                      {/* Agent Content Body: Rubric + Executions */}
                      {!isAgentCollapsed && (
                        <div className="p-4 flex flex-col gap-4">
                          {/* Agent Specific Rubric Bar */}
                          <div className="bg-card p-3 rounded-lg border border-border/40 flex items-center justify-between text-xs gap-3">
                            <div className="flex items-center gap-2">
                              <Scale className="size-4 text-amber-500 shrink-0" />
                              <span className="font-semibold">Evaluation Rubric Criteria:</span>
                              <div className="flex flex-wrap gap-1.5">
                                {defaultRubric.criteria.map((c, i) => {
                                  const name = "key" in c ? c.key : c.name;
                                  return (
                                    <Badge
                                      key={name || i}
                                      variant="outline"
                                      className="font-mono text-[10px]"
                                    >
                                      {name}
                                    </Badge>
                                  );
                                })}
                              </div>
                            </div>
                          </div>

                          {/* Agent LLM Generations Cards */}
                          <div className="flex flex-col gap-3">
                            {agentRuns.length === 0 ? (
                              <div className="py-6 text-center text-muted-foreground italic text-xs border border-dashed rounded-lg bg-muted/10">
                                No LLM executions logged for {agentObj.name} yet. Trigger a run in
                                Chat to evaluate.
                              </div>
                            ) : (
                              agentRuns.map((run) => (
                                <LLMGenerationCard
                                  key={run.id}
                                  run={run}
                                  onOpenTrace={onOpenTrace}
                                  onRunJudge={onRunJudge}
                                  evaluating={evaluating}
                                />
                              ))
                            )}
                          </div>
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
    </div>
  );
}
