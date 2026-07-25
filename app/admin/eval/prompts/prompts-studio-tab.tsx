"use client";

import React from "react";
import {
  ChevronDown,
  Copy,
  Edit3,
  GitBranch,
  Layers,
  Plus,
  Sliders,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { LANGGRAPH_GROUPS, Template, Variant } from "../types";

interface PromptsStudioTabProps {
  templates: Template[];
  variants: Variant[];
  collapsedGroups: Record<string, boolean>;
  toggleGroupCollapse: (groupId: string) => void;
  openTrafficModal: (agentId: string) => void;
  setAddingVariantTmplId: (tmplId: string) => void;
  openDeployDialogForAgent: (agentId: string) => void;
  copyToClipboard: (text: string) => void;
  openEditModal: (tmpl: Template) => void;
  openDeleteModal: (tmpl: Template) => void;
}

export function PromptsStudioTab({
  templates,
  variants,
  collapsedGroups,
  toggleGroupCollapse,
  openTrafficModal,
  setAddingVariantTmplId,
  openDeployDialogForAgent,
  copyToClipboard,
  openEditModal,
  openDeleteModal,
}: PromptsStudioTabProps) {
  return (
    <div className="flex flex-col gap-6">
      {LANGGRAPH_GROUPS.map((group) => {
        const Icon = group.icon;
        const isCollapsed = collapsedGroups[group.id];
        const groupTemplates = templates.filter(
          (t) =>
            t.group === group.id ||
            (group.id === "agent" && (!t.group || t.group === "Main Assistant")),
        );

        return (
          <Card key={group.id} className="overflow-hidden border-border/80 py-0 gap-0 shadow-2xs">
            {/* Group Card Header */}
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
                    <span className="font-mono">{group.entrypoint}</span>
                    <span className="mx-1.5">·</span>
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
                    <span>{isCollapsed ? "Expand" : "Collapse"}</span>
                    <ChevronDown
                      className={`size-3.5 transition-transform duration-200 ${
                        isCollapsed ? "-rotate-90" : "rotate-0"
                      }`}
                    />
                  </Button>
                </div>
              </div>
            </CardHeader>

            <div
              className={`grid transition-all duration-300 ease-in-out ${
                isCollapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"
              }`}
            >
              <div className="overflow-hidden">
                <CardContent className="p-6 flex flex-col gap-8">
                  {group.agents.map((agentObj, agentIdx) => {
                    const agentId = agentObj.id;
                    const agentTemplates = groupTemplates.filter((t) => t.agent === agentId);
                    const agentTmplIds = new Set(agentTemplates.map((t) => t.id));
                    const agentVariants = variants.filter((v) => agentTmplIds.has(v.templateId));
                    const totalAgentWeight = agentVariants.reduce(
                      (s, v) => s + (v.enabled ? Math.max(0, v.trafficWeight) : 0),
                      0,
                    );

                    return (
                      <div key={agentId} className="flex flex-col gap-4">
                        {agentIdx > 0 && <Separator className="mb-2" />}

                        {/* Agent Node Header Bar */}
                        <div className="flex items-center justify-between bg-muted/30 p-3 rounded-lg border border-border/60">
                          <div className="flex items-center gap-2">
                            <GitBranch className="size-4 text-primary shrink-0" />
                            <span className="font-mono text-sm font-semibold text-foreground">
                              {agentId}
                            </span>
                            <span className="text-xs text-muted-foreground font-normal">
                              ({agentObj.name})
                            </span>
                            <span className="mx-1 text-muted-foreground/40">·</span>
                            <span className="text-[11px] text-muted-foreground italic">
                              {agentObj.desc}
                            </span>
                          </div>
                          <Badge variant="secondary" className="font-mono text-[10px]">
                            {agentTemplates.length} Template{agentTemplates.length === 1 ? "" : "s"}
                          </Badge>
                        </div>

                        {/* SECTION 1: A/B Traffic & Variants */}
                        <div className="flex flex-col gap-2.5 pl-2">
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                              <Sliders className="size-3.5 text-primary" /> A/B Traffic Variants ({agentVariants.length})
                            </span>
                            <div className="flex items-center gap-2">
                              <Button
                                type="button"
                                variant="outline"
                                size="xs"
                                className="gap-1.5 font-medium"
                                onClick={() => openTrafficModal(agentId)}
                              >
                                <Sliders className="size-3.5 text-primary" />
                                <span>Set traffic</span>
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                className="text-[11px] h-7 px-2 text-muted-foreground hover:text-foreground"
                                onClick={() => {
                                  if (agentTemplates.length === 0) {
                                    toast.error("Please deploy a prompt template first before adding variants");
                                    return;
                                  }
                                  setAddingVariantTmplId(agentTemplates[0]!.id);
                                }}
                              >
                                + Add Variant
                              </Button>
                            </div>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                            {agentVariants.map((v) => {
                              const boundTmpl = templates.find((t) => t.id === v.templateId);
                              const pct =
                                totalAgentWeight > 0 && v.enabled
                                  ? Math.round((v.trafficWeight / totalAgentWeight) * 100)
                                  : 0;

                              return (
                                <div
                                  key={v.id}
                                  className="flex flex-col justify-between gap-2 bg-card border border-border/70 rounded-lg p-3 shadow-2xs"
                                >
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-1.5">
                                      <span className="font-semibold text-xs text-foreground">{v.label}</span>
                                      <span className="font-mono text-[10px] text-muted-foreground">({v.id})</span>
                                    </div>
                                    <Badge
                                      variant={v.enabled ? "default" : "secondary"}
                                      className="font-mono text-[10px] px-1.5 py-0"
                                    >
                                      {v.enabled ? `${pct}% TRAFFIC` : "DISABLED"}
                                    </Badge>
                                  </div>

                                  <div className="flex items-center justify-between bg-muted/40 border border-border/40 rounded-md px-2.5 py-1 text-[11px]">
                                    <span className="text-muted-foreground">Bound Template:</span>
                                    <span className="font-mono font-medium text-foreground">
                                      {boundTmpl ? boundTmpl.id : v.templateId}
                                    </span>
                                  </div>
                                </div>
                              );
                            })}

                            {agentVariants.length === 0 && (
                              <div className="col-span-full py-3 text-center text-muted-foreground italic text-xs bg-muted/20 border border-dashed rounded-lg">
                                No A/B variants configured for {agentId} yet.
                              </div>
                            )}
                          </div>
                        </div>

                        {/* SECTION 2: Prompt Templates Repository */}
                        <div className="flex flex-col gap-2.5 pl-2">
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                              <Layers className="size-3.5 text-primary" /> Prompt Templates Repository ({agentTemplates.length})
                            </span>
                            <Button
                              type="button"
                              variant="default"
                              size="xs"
                              className="gap-1.5 font-medium"
                              onClick={() => openDeployDialogForAgent(agentId)}
                            >
                              <Plus className="size-3.5" />
                              <span>Add prompt</span>
                            </Button>
                          </div>

                          <div className="border border-border/60 overflow-hidden rounded-lg bg-card">
                            <table className="w-full text-left text-xs">
                              <thead className="bg-muted/40 border-b text-muted-foreground font-medium uppercase text-[10px]">
                                <tr>
                                  <th className="px-4 py-2.5 w-[200px]">Template ID</th>
                                  <th className="px-4 py-2.5">Notes / Rationale</th>
                                  <th className="px-4 py-2.5 w-[180px]">Bound Variant Status</th>
                                  <th className="px-4 py-2.5 w-[110px]">Created Date</th>
                                  <th className="px-4 py-2.5 text-right w-[190px]">Actions</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y">
                                {agentTemplates.map((tmpl) => {
                                  const boundVariants = agentVariants.filter((v) => v.templateId === tmpl.id);
                                  const isSystemPrompt = !tmpl.userId;

                                  return (
                                    <tr key={tmpl.id} className="hover:bg-muted/20 transition-colors">
                                      <td className="px-4 py-3 align-middle font-mono font-medium text-foreground">
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
                                      </td>
                                      <td className="px-4 py-3 align-middle text-muted-foreground text-[11px]">
                                        {tmpl.notes || "—"}
                                      </td>
                                      <td className="px-4 py-3 align-middle">
                                        {boundVariants.length > 0 ? (
                                          <div className="flex flex-wrap gap-1">
                                            {boundVariants.map((bv) => (
                                              <Badge key={bv.id} variant="secondary" className="font-mono text-[10px]">
                                                {bv.label} ({bv.trafficWeight}%)
                                              </Badge>
                                            ))}
                                          </div>
                                        ) : (
                                          <span className="text-muted-foreground/60 text-[11px] italic">Unbound</span>
                                        )}
                                      </td>
                                      <td className="px-4 py-3 align-middle font-mono text-[11px] text-muted-foreground">
                                        {new Date(tmpl.createdAt).toLocaleDateString()}
                                      </td>
                                      <td className="px-4 py-3 text-right align-middle">
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
                                                ? "System prompt cannot be deleted"
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
                                      </td>
                                    </tr>
                                  );
                                })}

                                {agentTemplates.length === 0 && (
                                  <tr>
                                    <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground italic text-[11px]">
                                      No prompt template deployed for {agentId} yet. Click "Add prompt" to create one.
                                    </td>
                                  </tr>
                                )}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </CardContent>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
