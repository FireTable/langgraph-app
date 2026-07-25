"use client";

import React from "react";
import { Edit3 } from "lucide-react";
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
import { Template } from "../types";

interface EditPromptDialogProps {
  template: Template | null;
  onOpenChange: (open: boolean) => void;
  notes: string;
  onNotesChange: (notes: string) => void;
  content: string;
  onContentChange: (content: string) => void;
  onSave: () => void;
  saving: boolean;
}

export function EditPromptDialog({
  template,
  onOpenChange,
  notes,
  onNotesChange,
  content,
  onContentChange,
  onSave,
  saving,
}: EditPromptDialogProps) {
  return (
    <Dialog open={Boolean(template)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Edit3 className="size-4 text-primary" /> Edit Prompt Template
          </DialogTitle>
          <DialogDescription className="text-xs">
            Template ID:{" "}
            <span className="font-mono font-semibold text-foreground">{template?.id}</span> (Target
            Node: {template?.agent})
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3.5 text-xs py-2">
          <label className="flex flex-col gap-1">
            <span className="font-medium text-foreground">Version Notes / Rationale</span>
            <Input
              value={notes}
              onChange={(e) => onNotesChange(e.target.value)}
              placeholder="e.g. Updated system prompt for better JSON formatting"
              className="h-9 text-xs"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="font-medium text-foreground">System Prompt Content</span>
            <textarea
              value={content}
              onChange={(e) => onContentChange(e.target.value)}
              className="bg-background border-border min-h-[200px] rounded-md border p-2.5 font-mono text-xs focus:outline-hidden leading-relaxed"
            />
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={saving}>
            {saving ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
