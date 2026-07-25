"use client";

import React from "react";
import { GitBranch } from "lucide-react";
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
import { LANGGRAPH_GROUPS } from "../types";

interface DeployPromptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetAgent: string;
  onTargetAgentChange?: (agent: string) => void;
  content: string;
  onContentChange: (content: string) => void;
  notes: string;
  onNotesChange: (notes: string) => void;
  onSubmit: () => void;
  loading: boolean;
}

export function DeployPromptDialog({
  open,
  onOpenChange,
  targetAgent,
  content,
  onContentChange,
  notes,
  onNotesChange,
  onSubmit,
  loading,
}: DeployPromptDialogProps) {
  const agentObj = LANGGRAPH_GROUPS.flatMap((g) => g.agents).find((a) => a.id === targetAgent);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add prompt version</DialogTitle>
          <DialogDescription className="text-xs">
            Create a new System Prompt template version for node{" "}
            <span className="font-mono font-semibold text-foreground">{targetAgent}</span>.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3.5 text-xs py-2">
          {/* Read-only Target Agent Node Display */}
          <div className="flex flex-col gap-1.5">
            <span className="font-medium text-foreground">Target Agent Node</span>
            <div className="flex items-center justify-between bg-muted/40 border border-border/60 rounded-lg px-3 py-2">
              <div className="flex items-center gap-2">
                <GitBranch className="size-4 text-primary shrink-0" />
                <span className="font-mono text-xs font-semibold text-foreground">
                  {targetAgent}
                </span>
                {agentObj && (
                  <span className="text-xs text-muted-foreground">({agentObj.name})</span>
                )}
              </div>
              {agentObj?.desc && (
                <span className="text-[11px] text-muted-foreground italic hidden sm:inline">
                  {agentObj.desc}
                </span>
              )}
            </div>
          </div>

          <label className="flex flex-col gap-1">
            <span className="font-medium text-foreground">Version Notes / Rationale</span>
            <Input
              value={notes}
              onChange={(e) => onNotesChange(e.target.value)}
              placeholder="e.g. Optimized RAG instructions & concise tone"
              className="h-9 text-xs"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="font-medium text-foreground">System Prompt Template</span>
            <textarea
              value={content}
              onChange={(e) => onContentChange(e.target.value)}
              placeholder="You are an AI assistant..."
              className="bg-background border-border min-h-[180px] rounded-md border p-2.5 font-mono text-xs focus:outline-hidden leading-relaxed"
            />
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={loading}>
            {loading ? "Deploying..." : "Add prompt"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
