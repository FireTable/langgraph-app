"use client";

import React, { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  CornerDownRight,
  Edit3,
  GitBranch,
  Layers,
  Plus,
  Sliders,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { LANGGRAPH_GROUPS, Template, Variant } from "../types";

function truncateId(id: string, front = 3, back = 8): string {
  if (!id || id.length <= front + back + 3) return id;
  return `${id.slice(0, front)}...${id.slice(-back)}`;
}

interface PromptsStudioTabProps {
  templates: Template[];
  variants: Variant[];
  collapsedGroups: Record<string, boolean>;
  toggleGroupCollapse: (groupId: string) => void;
  openTrafficModal: (agentId: string) => void;
  openAddCohortDialog: () => void;
  openEditCohortDialog?: (
    cohortLabel: string,
    weight: number,
    bindings: Record<string, string>,
  ) => void;
  openDeployDialogForAgent: (agentId: string) => void;
  copyToClipboard: (text: string) => void;
  openEditModal: (tmpl: Template) => void;
  openDeleteModal: (tmpl: Template) => void;
  onDeleteCohort?: (cohortLabel: string) => void;
}

export function PromptsStudioTab({
  templates,
  variants,
  collapsedGroups,
  toggleGroupCollapse,
  openTrafficModal,
  openAddCohortDialog,
  openEditCohortDialog,
  openDeployDialogForAgent,
  copyToClipboard,
  openEditModal,
  openDeleteModal,
  onDeleteCohort,
}: PromptsStudioTabProps) {
  // Collapsible Agent Nodes state inside single table
  const [collapsedAgents, setCollapsedAgents] = useState<Record<string, boolean>>({});

  const toggleAgentCollapse = (agentId: string) => {
    setCollapsedAgents((prev) => ({ ...prev, [agentId]: !prev[agentId] }));
  };

  // Group variants by label to form Global Cohorts
  const cohortMap = new Map<string, Array<{ variant: Variant; template?: Template }>>();

  for (const v of variants) {
    const tmpl = templates.find((t) => t.id === v.templateId);
    const list = cohortMap.get(v.label) || [];
    list.push({ variant: v, template: tmpl });
    cohortMap.set(v.label, list);
  }

  const cohorts = Array.from(cohortMap.entries()).map(([label, items]) => {
    const enabled = items.some((i) => i.variant.enabled);
    const weight = items.reduce((s, i) => Math.max(s, i.variant.trafficWeight), 0);
    return { label, items, enabled, weight };
  });

  const totalCohortWeight = cohorts.reduce(
    (s, c) => s + (c.enabled ? Math.max(0, c.weight) : 0),
    0,
  );

  return (
    <div className="flex flex-col gap-8">
      {/* SECTION 1: Top Global A/B Traffic Variants */}
      <section className="flex flex-col gap-3.5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold">Global A/B Traffic Variants</h3>
            <p className="text-muted-foreground text-xs mt-0.5">
              Experiment variants configured across agent nodes. Traffic weights deterministically
              route user requests.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="gap-1.5 font-medium"
              onClick={() => openTrafficModal("all")}
            >
              <Sliders className="size-3.5 text-primary" />
              <span>Set Traffic Weight</span>
            </Button>
            <Button
              type="button"
              variant="default"
              size="xs"
              className="gap-1.5 font-medium"
              onClick={openAddCohortDialog}
            >
              <Plus className="size-3.5" />
              <span>Add Variant</span>
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {cohorts.map((cohort) => {
            const pct =
              totalCohortWeight > 0 && cohort.enabled
                ? Math.round((cohort.weight / totalCohortWeight) * 100)
                : 0;
            const isDefault = cohort.label.toLowerCase() === "default";

            // Extract bindings for this cohort
            const bindingsMap: Record<string, string> = {};
            for (const item of cohort.items) {
              if (item.template?.agent) {
                bindingsMap[item.template.agent] = item.variant.templateId;
              }
            }

            return (
              <Card
                key={cohort.label}
                className="border-border/80 shadow-2xs flex flex-col justify-between overflow-hidden p-0 gap-0"
              >
                {/* Cohort Card Header with Action Icons at Top Right */}
                <div className="p-3.5 bg-muted/20 border-b border-border/40 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Sparkles className="size-4 text-primary shrink-0" />
                      <span className="text-sm font-bold font-mono text-foreground uppercase">
                        {cohort.label}
                      </span>
                      <Badge
                        variant={cohort.enabled ? "default" : "secondary"}
                        className="font-mono text-[10px] px-2 py-0.5"
                      >
                        {cohort.enabled ? `${pct}% TRAFFIC` : "DISABLED"}
                      </Badge>
                    </div>

                    {/* Action Icon Buttons: Edit & Delete */}
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground hover:text-foreground"
                        title={`Edit ${cohort.label} Agent Node Prompt Bindings`}
                        onClick={() => {
                          if (openEditCohortDialog) {
                            openEditCohortDialog(cohort.label, cohort.weight, bindingsMap);
                          } else {
                            openTrafficModal("chatAgent");
                          }
                        }}
                      >
                        <Edit3 className="size-3.5" />
                      </Button>

                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={isDefault}
                        title={
                          isDefault
                            ? "Default variant cannot be deleted"
                            : `Delete ${cohort.label} Variant`
                        }
                        onClick={() => {
                          if (isDefault) return;
                          if (onDeleteCohort) {
                            onDeleteCohort(cohort.label);
                          }
                        }}
                        className={
                          isDefault
                            ? "size-7 opacity-40 cursor-not-allowed text-muted-foreground"
                            : "size-7 text-muted-foreground hover:text-rose-500 hover:bg-rose-500/10"
                        }
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>

                <CardContent className="p-3.5 flex flex-col gap-2 text-xs">
                  <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                    Agent Node Prompt Bindings:
                  </span>
                  <div className="flex flex-col gap-1.5">
                    {cohort.items.map(({ variant, template }) => {
                      const fullId = template?.id || variant.templateId;
                      const truncated = truncateId(fullId);

                      return (
                        <div
                          key={variant.id}
                          className="flex items-center justify-between bg-muted/30 px-2.5 py-1.5 rounded-md border border-border/40 font-mono text-[11px] gap-2"
                        >
                          <span className="font-semibold text-foreground shrink-0">
                            {template?.agent || "agent"}
                          </span>
                          <div className="flex items-center gap-1 min-w-0 shrink-0">
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="text-muted-foreground text-[10px] whitespace-nowrap font-mono cursor-pointer hover:text-foreground hover:underline">
                                    {truncated}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent className="font-mono text-xs max-w-xs break-all">
                                  {fullId}
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>

                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="size-5 text-muted-foreground hover:text-foreground shrink-0"
                              title="Copy Template ID"
                              onClick={() => copyToClipboard(fullId)}
                            >
                              <Copy className="size-3" />
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            );
          })}

          {cohorts.length === 0 && (
            <div className="col-span-full py-8 text-center text-muted-foreground italic text-xs bg-muted/20 border border-dashed rounded-xl">
              No global experiment variants configured yet. Click "+ Add Variant" to create one.
            </div>
          )}
        </div>
      </section>

      <Separator />

      {/* SECTION 2: Bottom Prompt Templates Repository (Single Consolidated Table per Graph Group) */}
      <section className="flex flex-col gap-4">
        <div>
          <h3 className="text-base font-semibold">Prompt Templates Repository</h3>
          <p className="text-muted-foreground text-xs mt-0.5">
            System prompt versions deployed per agent node. Edit prompt content, add notes, or
            deploy new iterations.
          </p>
        </div>

        <div className="flex flex-col gap-6">
          {LANGGRAPH_GROUPS.map((group) => {
            const Icon = group.icon;
            const isGroupCollapsed = collapsedGroups[group.id];
            const groupTemplates = templates.filter(
              (t) =>
                t.group === group.id ||
                (group.id === "agent" && (!t.group || t.group === "Main Assistant")),
            );

            return (
              <Card
                key={group.id}
                className="overflow-hidden border-border/80 py-0 gap-0 shadow-2xs"
              >
                {/* Graph Group Card Header */}
                <CardHeader className="p-6 border-b border-border/60">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <Icon className="size-4 text-primary shrink-0" />
                        <CardTitle className="text-base font-semibold">{group.label}</CardTitle>
                        <Badge variant="outline" className="font-mono text-[10px]">
                          {group.id}
                        </Badge>
                      </div>
                      <CardDescription className="text-xs text-muted-foreground">
                        {group.description}
                      </CardDescription>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => toggleGroupCollapse(group.id)}
                        className="gap-1.5"
                      >
                        <span>{isGroupCollapsed ? "Expand" : "Collapse"}</span>
                        <ChevronDown
                          className={`size-3.5 transition-transform duration-200 ${
                            isGroupCollapsed ? "-rotate-90" : "rotate-0"
                          }`}
                        />
                      </Button>
                    </div>
                  </div>
                </CardHeader>

                <div
                  className={`grid transition-all duration-300 ease-in-out ${
                    isGroupCollapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"
                  }`}
                >
                  <div className="overflow-hidden">
                    <CardContent className="p-6">
                      {/* SINGLE CONSOLIDATED TABLE PER GRAPH GROUP */}
                      <div className="border border-border/60 overflow-hidden rounded-xl bg-card">
                        <Table className="text-xs">
                          <TableHeader className="bg-muted/50 uppercase text-[10px]">
                            <TableRow>
                              <TableHead className="w-[260px]">Target Node / Template ID</TableHead>
                              <TableHead>Notes / Rationale</TableHead>
                              <TableHead className="w-[200px]">Bound Cohort Variants</TableHead>
                              <TableHead className="w-[120px]">Created Date</TableHead>
                              <TableHead className="text-right w-[200px]">Actions</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {group.agents.map((agentObj) => {
                              const agentId = agentObj.id;
                              const isAgentCollapsed = collapsedAgents[agentId];
                              const agentTemplates = groupTemplates.filter(
                                (t) => t.agent === agentId,
                              );
                              const agentTmplIds = new Set(agentTemplates.map((t) => t.id));
                              const agentVariants = variants.filter((v) =>
                                agentTmplIds.has(v.templateId),
                              );

                              return (
                                <React.Fragment key={agentId}>
                                  {/* PARENT ROW: Agent Node Row (Clickable to Expand/Collapse) */}
                                  <TableRow
                                    onClick={() => toggleAgentCollapse(agentId)}
                                    className="bg-muted/30 hover:bg-muted/50 cursor-pointer select-none font-medium border-t border-b border-border/60"
                                  >
                                    <TableCell colSpan={4} className="py-3">
                                      <div className="flex items-center gap-2">
                                        {isAgentCollapsed ? (
                                          <ChevronRight className="size-4 text-muted-foreground shrink-0" />
                                        ) : (
                                          <ChevronDown className="size-4 text-primary shrink-0" />
                                        )}
                                        <GitBranch className="size-4 text-primary shrink-0" />
                                        <Badge
                                          variant="secondary"
                                          className="font-mono text-[10px] px-1.5 py-0.5"
                                        >
                                          {agentTemplates.length}
                                        </Badge>
                                        <span className="font-mono text-sm font-semibold text-foreground">
                                          {agentId}
                                        </span>
                                      </div>
                                    </TableCell>
                                    <TableCell className="py-3 text-right">
                                      <Button
                                        type="button"
                                        variant="default"
                                        size="xs"
                                        className="gap-1.5 font-medium"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          openDeployDialogForAgent(agentId);
                                        }}
                                      >
                                        <Plus className="size-3.5" />
                                        <span>Add prompt</span>
                                      </Button>
                                    </TableCell>
                                  </TableRow>

                                  {/* CHILD ROWS: Prompt Template Rows */}
                                  {!isAgentCollapsed &&
                                    (agentTemplates.length === 0 ? (
                                      <TableRow className="hover:bg-muted/10">
                                        <TableCell
                                          colSpan={5}
                                          className="px-8 py-3 text-muted-foreground italic text-[11px]"
                                        >
                                          <div className="flex items-center gap-2">
                                            <CornerDownRight className="size-3.5 text-muted-foreground/60 shrink-0" />
                                            <span>
                                              No prompt template deployed for {agentId} yet. Click
                                              "Add prompt" to create one.
                                            </span>
                                          </div>
                                        </TableCell>
                                      </TableRow>
                                    ) : (
                                      agentTemplates.map((tmpl) => {
                                        const boundVariants = agentVariants.filter(
                                          (v) => v.templateId === tmpl.id,
                                        );
                                        const isSystemPrompt = !tmpl.userId;

                                        return (
                                          <TableRow
                                            key={tmpl.id}
                                            className="hover:bg-muted/20 bg-background/50"
                                          >
                                            <TableCell className="py-3 font-mono font-medium text-foreground">
                                              <div className="flex items-center gap-2 pl-6">
                                                <CornerDownRight className="size-3.5 text-muted-foreground/60 shrink-0" />
                                                <div className="flex items-center gap-1.5">
                                                  <span>{tmpl.id}</span>
                                                  {isSystemPrompt && (
                                                    <Badge
                                                      variant="outline"
                                                      className="text-[9px] px-1 py-0 font-sans text-muted-foreground bg-muted/40"
                                                    >
                                                      System
                                                    </Badge>
                                                  )}
                                                </div>
                                              </div>
                                            </TableCell>
                                            <TableCell className="py-3 text-muted-foreground text-[11px]">
                                              {tmpl.notes || "—"}
                                            </TableCell>
                                            <TableCell className="py-3">
                                              {boundVariants.length > 0 ? (
                                                <div className="flex flex-wrap gap-1">
                                                  {boundVariants.map((bv) => (
                                                    <Badge
                                                      key={bv.id}
                                                      variant="secondary"
                                                      className="font-mono text-[10px]"
                                                    >
                                                      {bv.label} ({bv.trafficWeight}%)
                                                    </Badge>
                                                  ))}
                                                </div>
                                              ) : (
                                                <span className="text-muted-foreground/60 text-[11px] italic">
                                                  Unbound
                                                </span>
                                              )}
                                            </TableCell>
                                            <TableCell className="py-3 font-mono text-[11px] text-muted-foreground">
                                              {new Date(tmpl.createdAt).toLocaleDateString()}
                                            </TableCell>
                                            <TableCell className="py-3 text-right">
                                              <div className="flex justify-end gap-1">
                                                <Button
                                                  type="button"
                                                  variant="outline"
                                                  size="xs"
                                                  onClick={() => copyToClipboard(tmpl.content)}
                                                  title="Copy Prompt Content"
                                                >
                                                  <Copy className="size-3 mr-1" /> Copy
                                                </Button>
                                                <Button
                                                  type="button"
                                                  variant="outline"
                                                  size="xs"
                                                  onClick={() => openEditModal(tmpl)}
                                                  title="Edit Prompt Template"
                                                >
                                                  <Edit3 className="size-3 mr-1" /> Edit
                                                </Button>
                                                <Button
                                                  type="button"
                                                  variant="outline"
                                                  size="xs"
                                                  onClick={() => openDeleteModal(tmpl)}
                                                  disabled={isSystemPrompt}
                                                  title={
                                                    isSystemPrompt
                                                      ? "System default prompts cannot be deleted"
                                                      : "Delete Prompt"
                                                  }
                                                  className={
                                                    isSystemPrompt
                                                      ? "opacity-50 cursor-not-allowed text-muted-foreground"
                                                      : "text-rose-500 hover:text-rose-600 hover:bg-rose-500/10"
                                                  }
                                                >
                                                  <Trash2 className="size-3 mr-1" /> Delete
                                                </Button>
                                              </div>
                                            </TableCell>
                                          </TableRow>
                                        );
                                      })
                                    ))}
                                </React.Fragment>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    </CardContent>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      </section>
    </div>
  );
}
