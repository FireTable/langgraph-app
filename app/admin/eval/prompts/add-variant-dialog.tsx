"use client";

import React, { useEffect, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LANGGRAPH_GROUPS, Template } from "../types";

export interface CohortFormData {
  label: string;
  trafficWeight: number;
  bindings: Record<string, string>;
}

interface AddCohortVariantDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: Template[];
  initialCohort?: CohortFormData | null;
  onSubmit: (cohortData: CohortFormData) => void;
  submitting: boolean;
}

export function AddCohortVariantDialog({
  open,
  onOpenChange,
  templates,
  initialCohort,
  onSubmit,
  submitting,
}: AddCohortVariantDialogProps) {
  const [label, setLabel] = useState("");
  const [weight, setWeight] = useState("0");
  const [bindings, setBindings] = useState<Record<string, string>>({});

  const isEditing = Boolean(initialCohort?.label);
  const allAgents = LANGGRAPH_GROUPS.flatMap((g) => g.agents);

  useEffect(() => {
    if (open) {
      if (initialCohort) {
        setLabel(initialCohort.label);
        setWeight(String(initialCohort.trafficWeight ?? 0));
        setBindings(initialCohort.bindings || {});
      } else {
        setLabel("");
        setWeight("0");
        setBindings({});
      }
    }
  }, [open, initialCohort]);

  const handleSelectBinding = (agentId: string, tmplId: string) => {
    setBindings((prev) => ({ ...prev, [agentId]: tmplId }));
  };

  const handleFormSubmit = () => {
    if (!label.trim()) return;

    // Fill defaults for unselected agents
    const finalBindings: Record<string, string> = {};
    for (const a of allAgents) {
      if (bindings[a.id]) {
        finalBindings[a.id] = bindings[a.id];
      } else {
        const agentTmpls = templates.filter((t) => t.agent === a.id);
        if (agentTmpls.length > 0) {
          finalBindings[a.id] = agentTmpls[0].id;
        }
      }
    }

    onSubmit({
      label: label.trim(),
      trafficWeight: parseInt(weight) || 0,
      bindings: finalBindings,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="p-6 pb-4 border-b border-border/60">
          <DialogTitle className="text-base sm:text-lg">
            {isEditing ? `Edit Variant: ${label}` : "Add Variant"}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {isEditing
              ? "Modify agent node prompt bindings for this experiment variant."
              : "Define an experiment variant (e.g. v2_beta) and specify prompt template bindings across agent nodes."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 p-6 overflow-y-auto max-h-[60vh] text-xs">
          {/* Variant Label Input */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-semibold text-foreground">Variant Label / ID</Label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              disabled={isEditing}
              placeholder="e.g. v2_experiment"
              className="h-9 text-xs font-mono disabled:opacity-70 disabled:bg-muted"
            />
          </div>

          {/* Node Bindings Grid */}
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5">
              <span className="font-semibold text-foreground text-xs uppercase tracking-wider">
                Agent Node Prompt Bindings
              </span>
              <span className="text-[11px] text-muted-foreground italic">
                Select bound prompt template per node
              </span>
            </div>

            {/* Vertical Stack Layout */}
            <div className="flex flex-col gap-3">
              {allAgents.map((agentObj) => {
                const agentId = agentObj.id;
                const agentTemplates = templates.filter((t) => t.agent === agentId);
                const selectedTmplId = bindings[agentId] || (agentTemplates[0]?.id ?? "");

                return (
                  <div
                    key={agentId}
                    className="flex flex-col gap-2 bg-card p-3 rounded-xl border border-border/70 shadow-2xs"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-semibold text-foreground text-xs">
                          {agentId}
                        </span>
                        <span className="text-muted-foreground text-[11px]">
                          ({agentObj.name})
                        </span>
                      </div>
                    </div>

                    <div className="w-full">
                      <Select
                        value={selectedTmplId}
                        onValueChange={(val) => handleSelectBinding(agentId, val)}
                      >
                        <SelectTrigger className="h-9 w-full text-xs font-mono">
                          <SelectValue placeholder="Select template" />
                        </SelectTrigger>
                        <SelectContent>
                          {agentTemplates.map((tmpl) => (
                            <SelectItem key={tmpl.id} value={tmpl.id} className="text-xs font-mono">
                              {tmpl.id} {tmpl.notes ? `(${tmpl.notes})` : ""}
                            </SelectItem>
                          ))}
                          {agentTemplates.length === 0 && (
                            <SelectItem value="none" disabled className="text-xs italic text-muted-foreground">
                              No templates deployed
                            </SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <DialogFooter className="p-4 border-t border-border/60 bg-muted/20">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={handleFormSubmit} disabled={submitting || !label.trim()}>
            {submitting
              ? isEditing
                ? "Saving..."
                : "Creating Variant..."
              : isEditing
                ? "Save Changes"
                : "Add Variant"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
