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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="p-6 pb-4 border-b border-border/60">
          <DialogTitle className="text-base sm:text-lg">Add prompt version</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Create a new System Prompt template version for node{" "}
            <span className="font-mono font-semibold text-foreground">{targetAgent}</span>.
          </DialogDescription>
        </DialogHeader>

        <div className="p-6 overflow-y-auto max-h-[60vh] flex flex-col gap-4 text-xs">
          {/* Read-only Target Agent Node Display */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-semibold text-foreground">Target Agent Node</Label>
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

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-semibold text-foreground">Version Notes / Rationale</Label>
            <Input
              value={notes}
              onChange={(e) => onNotesChange(e.target.value)}
              placeholder="e.g. Optimized RAG instructions & concise tone"
              className="h-9 text-xs"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-semibold text-foreground">System Prompt Template</Label>
            <Textarea
              value={content}
              onChange={(e) => onContentChange(e.target.value)}
              placeholder="You are an AI assistant..."
              className="min-h-[220px] max-h-[360px] overflow-y-auto font-mono text-xs leading-relaxed resize-y"
            />
          </div>
        </div>

        <DialogFooter className="p-4 border-t border-border/60 bg-muted/20">
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
