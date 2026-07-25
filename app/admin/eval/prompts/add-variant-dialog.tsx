"use client";

import React from "react";
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

interface AddVariantDialogProps {
  templateId: string | null;
  onOpenChange: (open: boolean) => void;
  label: string;
  onLabelChange: (label: string) => void;
  weight: string;
  onWeightChange: (weight: string) => void;
  onSubmit: () => void;
}

export function AddVariantDialog({
  templateId,
  onOpenChange,
  label,
  onLabelChange,
  weight,
  onWeightChange,
  onSubmit,
}: AddVariantDialogProps) {
  return (
    <Dialog open={Boolean(templateId)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add A/B Traffic Variant</DialogTitle>
          <DialogDescription>
            Add a new variant for template{" "}
            <span className="font-mono font-semibold">{templateId}</span>.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 text-xs py-2">
          <label className="flex flex-col gap-1.5">
            <span className="font-medium">Variant Label</span>
            <Input
              value={label}
              onChange={(e) => onLabelChange(e.target.value)}
              placeholder="e.g. treatment_b"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-medium">Initial Traffic Weight</span>
            <Input
              type="number"
              value={weight}
              onChange={(e) => onWeightChange(e.target.value)}
              placeholder="50"
            />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onSubmit}>Add variant</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
