"use client";

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
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="p-6 pb-4 border-b border-border/60">
          <DialogTitle className="text-base sm:text-lg">
            Edit Prompt Template
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Template ID:{" "}
            <span className="font-mono font-semibold text-foreground">{template?.id}</span> (Target
            Node: {template?.agent})
          </DialogDescription>
        </DialogHeader>

        <div className="p-6 overflow-y-auto max-h-[60vh] flex flex-col gap-4 text-xs">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-semibold text-foreground">Version Notes / Rationale</Label>
            <Input
              value={notes}
              onChange={(e) => onNotesChange(e.target.value)}
              placeholder="e.g. Updated system prompt for better JSON formatting"
              className="h-9 text-xs"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-semibold text-foreground">System Prompt Content</Label>
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
          <Button onClick={onSave} disabled={saving}>
            {saving ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
