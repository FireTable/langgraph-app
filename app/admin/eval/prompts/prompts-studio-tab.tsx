"use client";

import React, { useState } from "react";
import {
  ChevronDown,
  Copy,
  CornerDownRight,
  Edit3,
  Plus,
  Sliders,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { AgentGroupCard } from "../components/agent-group-card";
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
              <AgentGroupCard
                key={group.id}
                id={group.id}
                label={group.label}
                description={group.description}
                icon={Icon}
                isCollapsed={isGroupCollapsed}
                onToggleCollapse={() => toggleGroupCollapse(group.id)}
              >
                {/* SINGLE CONSOLIDATED TABLE PER GRAPH GROUP */}
                <div className="border border-border/60 overflow-hidden rounded-xl bg-card">
                  <Table className="text-xs [&_td]:py-2 [&_th]:py-2 [&_th]:h-8">
                    <TableHeader className="bg-muted/50 uppercase text-[10px]">
                      <TableRow>
                        <TableHead className="w-[260px]">Target Node / Template ID</TableHead>
                        <TableHead>Notes / Rationale</TableHead>
                        <TableHead className="w-[200px]">Traffic Weight</TableHead>
                        <TableHead className="w-[120px]">CreatedAt</TableHead>
                        <TableHead className="text-right w-[200px]">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.agents.map((agentObj) => {
                        const agentId = agentObj.id;
                        const isAgentCollapsed = collapsedAgents[agentId];
                        const agentTemplates = groupTemplates.filter((t) => t.agent === agentId);

                        return (
                          <React.Fragment key={agentId}>
                            {/* Parent Row: Agent Node */}
                            <TableRow className="bg-muted/20 hover:bg-muted/30 font-medium">
                              <TableCell colSpan={2} className="py-2.5">
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
                              </TableCell>
                              <TableCell className="py-2.5"></TableCell>
                              <TableCell className="py-2.5 text-muted-foreground font-mono text-[11px]"></TableCell>
                              <TableCell className="text-right py-2.5">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="xs"
                                  className="gap-1 font-medium"
                                  onClick={() => openDeployDialogForAgent(agentId)}
                                >
                                  <Plus className="size-3" /> Add prompt
                                </Button>
                              </TableCell>
                            </TableRow>

                            {/* Child Rows: Prompt Templates for this Agent Node */}
                            {!isAgentCollapsed &&
                              (agentTemplates.length === 0 ? (
                                <TableRow className="hover:bg-transparent">
                                  <TableCell
                                    colSpan={5}
                                    className="text-muted-foreground/60 italic text-xs py-3 pl-12"
                                  >
                                    No prompt templates deployed for this node yet. Click "+ Add
                                    prompt" to create one.
                                  </TableCell>
                                </TableRow>
                              ) : (
                                agentTemplates.map((tmpl) => {
                                  const boundVariants = variants.filter(
                                    (v) => v.templateId === tmpl.id,
                                  );

                                  return (
                                    <TableRow key={tmpl.id} className="hover:bg-muted/10">
                                      <TableCell className="font-mono text-xs font-medium pl-12">
                                        <div className="flex items-center gap-2">
                                          <CornerDownRight className="size-3 text-muted-foreground shrink-0" />
                                          <TooltipProvider>
                                            <Tooltip>
                                              <TooltipTrigger asChild>
                                                <span className="text-foreground whitespace-nowrap font-mono cursor-pointer hover:text-primary">
                                                  {truncateId(tmpl.id)}
                                                </span>
                                              </TooltipTrigger>
                                              <TooltipContent className="font-mono text-xs max-w-xs break-all">
                                                {tmpl.id}
                                              </TooltipContent>
                                            </Tooltip>
                                          </TooltipProvider>
                                          {!tmpl.userId && (
                                            <Badge
                                              variant="secondary"
                                              className="text-[9px] font-mono px-1.5 py-0"
                                            >
                                              SYSTEM
                                            </Badge>
                                          )}
                                        </div>
                                      </TableCell>

                                      <TableCell className="min-w-[320px] text-muted-foreground text-xs font-sans whitespace-normal break-words">
                                        {tmpl.notes || (
                                          <span className="italic text-muted-foreground/50">
                                            No notes provided
                                          </span>
                                        )}
                                      </TableCell>

                                      <TableCell className="font-mono text-[11px]">
                                        <div className="flex flex-wrap gap-1">
                                          {boundVariants.map((v) => (
                                            <Badge
                                              key={v.id}
                                              variant="outline"
                                              className="text-[10px] uppercase font-mono px-1.5 py-0"
                                            >
                                              {v.label} ({v.trafficWeight}%)
                                            </Badge>
                                          ))}
                                          {boundVariants.length === 0 && (
                                            <span className="text-muted-foreground/50 text-xs font-sans italic">
                                              Unbound
                                            </span>
                                          )}
                                        </div>
                                      </TableCell>

                                      <TableCell className="text-muted-foreground font-mono text-[11px]">
                                        {new Date(tmpl.createdAt).toLocaleDateString()}
                                      </TableCell>

                                      <TableCell className="text-right">
                                        <div className="flex items-center justify-end gap-1">
                                          <Button
                                            type="button"
                                            variant="outline"
                                            size="xs"
                                            onClick={() => copyToClipboard(tmpl.content)}
                                            title="Copy Full Prompt Content"
                                          >
                                            <Copy className="size-3 mr-1" /> Copy
                                          </Button>
                                          <Button
                                            type="button"
                                            variant="outline"
                                            size="xs"
                                            onClick={() => openEditModal(tmpl)}
                                            title="Edit Prompt Notes & Content"
                                          >
                                            <Edit3 className="size-3 mr-1" /> Edit
                                          </Button>

                                          <Button
                                            type="button"
                                            variant="outline"
                                            size="xs"
                                            disabled={!tmpl.userId}
                                            title={
                                              !tmpl.userId
                                                ? "System default prompts cannot be deleted"
                                                : "Delete Prompt Template"
                                            }
                                            onClick={() => openDeleteModal(tmpl)}
                                            className={
                                              !tmpl.userId
                                                ? "opacity-40 cursor-not-allowed text-muted-foreground"
                                                : "text-rose-500 hover:text-rose-600 hover:bg-rose-500/10 border-rose-500/40 hover:border-rose-500"
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
              </AgentGroupCard>
            );
          })}
        </div>
      </section>
    </div>
  );
}
