"use client";

import React, { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";

interface EditRubricDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  agentName: string;
  initialCriteria?: Array<{ key: string; description: string; weight?: number }>;
  onSave: (criteria: Array<{ key: string; description: string; weight?: number }>) => Promise<void>;
  saving?: boolean;
}

export function EditRubricDialog({
  open,
  onOpenChange,
  agentId,
  agentName,
  initialCriteria = [
    { key: "accuracy", description: "Factual correctness and accuracy", weight: 0.5 },
    { key: "relevance", description: "Relevance to user prompt", weight: 0.5 },
  ],
  onSave,
  saving = false,
}: EditRubricDialogProps) {
  const [criteria, setCriteria] = useState(initialCriteria);

  const handleAddCriterion = () => {
    setCriteria((prev) => [...prev, { key: "", description: "", weight: 0 }]);
  };

  const handleRemoveCriterion = (index: number) => {
    setCriteria((prev) => prev.filter((_, i) => i !== index));
  };

  const handleChangeCriterion = (
    index: number,
    field: "key" | "description" | "weight",
    val: string | number,
  ) => {
    setCriteria((prev) => prev.map((c, i) => (i === index ? { ...c, [field]: val } : c)));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const valid = criteria.filter((c) => c.key.trim().length > 0);
    await onSave(valid);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">
              Edit Rubric Criteria for {agentName}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Define the evaluation criteria, descriptions, and weights used by the AI Judge for
              this agent node.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3 max-h-[340px] overflow-y-auto pr-1">
            {criteria.map((c, idx) => (
              <div
                key={idx}
                className="p-3 border border-border/60 rounded-lg flex flex-col gap-2 bg-muted/20"
              >
                <div className="flex items-center gap-2">
                  <Input
                    placeholder="Criterion Key (e.g. accuracy)"
                    value={c.key}
                    onChange={(e) => handleChangeCriterion(idx, "key", e.target.value)}
                    className="font-mono text-xs h-8"
                    required
                  />
                  <div className="relative shrink-0">
                    <Input
                      type="number"
                      step="5"
                      min="0"
                      max="100"
                      value={Math.round((c.weight ?? 0) * 100)}
                      onChange={(e) =>
                        handleChangeCriterion(idx, "weight", Number(e.target.value) / 100)
                      }
                      className="font-mono text-xs h-8 w-20 pr-6"
                    />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground font-mono pointer-events-none">
                      %
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-rose-500 shrink-0"
                    onClick={() => handleRemoveCriterion(idx)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
                <Textarea
                  placeholder="Evaluation guidelines for LLM Judge..."
                  value={c.description}
                  onChange={(e) => handleChangeCriterion(idx, "description", e.target.value)}
                  className="text-xs resize-none h-16"
                  required
                />
              </div>
            ))}
          </div>

          <Button
            type="button"
            variant="outline"
            size="xs"
            className="gap-1 font-medium self-start"
            onClick={handleAddCriterion}
          >
            <Plus className="size-3.5" /> Add Criterion
          </Button>

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? "Saving..." : "Save Rubric"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
