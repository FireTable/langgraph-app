"use client";

import React, { useState } from "react";
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

interface AddBenchmarkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  agentName: string;
  onAdd: (data: {
    agent: string;
    title: string;
    inputPrompt: string;
    expectedOutput?: string;
  }) => Promise<void>;
  submitting?: boolean;
}

export function AddBenchmarkDialog({
  open,
  onOpenChange,
  agentId,
  agentName,
  onAdd,
  submitting = false,
}: AddBenchmarkDialogProps) {
  const [title, setTitle] = useState("");
  const [inputPrompt, setInputPrompt] = useState("");
  const [expectedOutput, setExpectedOutput] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !inputPrompt) return;
    await onAdd({
      agent: agentId,
      title,
      inputPrompt,
      expectedOutput: expectedOutput || undefined,
    });
    setTitle("");
    setInputPrompt("");
    setExpectedOutput("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">
              Add Benchmark Test Case for {agentName}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Define a test prompt and optional ground truth expected output to benchmark this agent
              node.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold">Test Case Title</label>
              <Input
                placeholder="e.g. Basic Greeting Test"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="text-xs"
                required
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold">Input Test Prompt</label>
              <Textarea
                placeholder="User message or test prompt to send to agent..."
                value={inputPrompt}
                onChange={(e) => setInputPrompt(e.target.value)}
                className="text-xs resize-none h-20"
                required
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-muted-foreground">
                Expected Output / Ground Truth (Optional)
              </label>
              <Textarea
                placeholder="Expected response or key factual criteria for AI Judge..."
                value={expectedOutput}
                onChange={(e) => setExpectedOutput(e.target.value)}
                className="text-xs resize-none h-20"
              />
            </div>
          </div>

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={submitting}>
              {submitting ? "Adding..." : "Add Test Case"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
