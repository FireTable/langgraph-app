"use client";

import React from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Template } from "../types";

interface DeletePromptDialogProps {
  template: Template | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  deleting: boolean;
}

export function DeletePromptDialog({
  template,
  onOpenChange,
  onConfirm,
  deleting,
}: DeletePromptDialogProps) {
  return (
    <Dialog open={Boolean(template)} onOpenChange={onOpenChange}>
      <DialogContent className="w-[92vw] max-w-md p-5 sm:p-6 rounded-2xl border-border/80 shadow-lg gap-4">
        <DialogHeader className="flex flex-col items-start gap-2.5 sm:gap-3 text-left">
          <div className="flex size-10 items-center justify-center rounded-full bg-rose-500/10 text-rose-500 dark:bg-rose-500/20 shrink-0">
            <AlertTriangle className="size-5" />
          </div>
          <div>
            <DialogTitle className="text-base sm:text-lg font-semibold text-foreground">
              Delete Prompt Template?
            </DialogTitle>

            <DialogDescription className="text-xs text-muted-foreground mt-1 leading-relaxed">
              Are you sure you want to permanently delete prompt template{" "}
              <span className="font-mono font-semibold text-foreground bg-muted/60 px-1.5 py-0.5 rounded-md">
                {template?.id}
              </span>{" "}
              for agent node{" "}
              <span className="font-mono font-semibold text-foreground">{template?.agent}</span>?
              This action cannot be undone.
            </DialogDescription>
          </div>
        </DialogHeader>

        {template?.notes && (
          <div className="bg-muted/40 border border-border/60 rounded-lg p-3 text-xs text-muted-foreground flex flex-col gap-1">
            <span className="font-medium text-foreground text-[11px] uppercase tracking-wider">
              Template Rationale:
            </span>
            <span className="italic line-clamp-2">{template.notes}</span>
          </div>
        )}

        <DialogFooter className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 mt-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            className="w-full sm:w-auto h-9 text-xs font-medium"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={onConfirm}
            disabled={deleting}
            className="w-full sm:w-auto h-9 text-xs font-medium gap-1.5 bg-rose-600 hover:bg-rose-700 text-white"
          >
            <Trash2 className="size-3.5" />
            <span>{deleting ? "Deleting..." : "Delete Prompt"}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
