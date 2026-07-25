"use client";

import React from "react";
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

export interface TrafficItem {
  variantId: string;
  label: string;
  templateId: string;
  weight: number;
  enabled: boolean;
}

interface TrafficSplitDialogProps {
  agentId: string | null;
  onOpenChange: (open: boolean) => void;
  items: TrafficItem[];
  setItems: React.Dispatch<React.SetStateAction<TrafficItem[]>>;
  onAutoBalance: () => void;
  onSave: () => void;
  saving: boolean;
}

export function TrafficSplitDialog({
  agentId,
  onOpenChange,
  items,
  setItems,
  onAutoBalance,
  onSave,
  saving,
}: TrafficSplitDialogProps) {
  const activeSum = items
    .filter((i) => i.enabled)
    .reduce((s, i) => s + (i.weight || 0), 0);
  const isValid = activeSum === 100;

  const handleWeightChange = (index: number, val: number) => {
    const clamped = Math.max(0, Math.min(100, val));
    setItems((prev) =>
      prev.map((item, idx) => (idx === index ? { ...item, weight: clamped } : item)),
    );
  };

  const handleToggleEnable = (index: number) => {
    setItems((prev) =>
      prev.map((item, idx) => (idx === index ? { ...item, enabled: !item.enabled } : item)),
    );
  };

  return (
    <Dialog open={Boolean(agentId)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="p-6 pb-4 border-b border-border/60">
          <DialogTitle className="text-base sm:text-lg">
            Traffic Weight Allocation
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Configure A/B test traffic percentages across all agent nodes. Sum of active traffic weights must equal exactly 100%.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 p-6 overflow-y-auto max-h-[60vh] text-xs">
          <div className="flex items-center justify-between bg-muted/30 p-2.5 rounded-lg border border-border/60">
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground">Traffic Sum:</span>
              <Badge
                variant={isValid ? "default" : "destructive"}
                className="font-mono text-xs"
              >
                {activeSum}% {isValid ? "✓ VALID" : "✗ Must equal 100%"}
              </Badge>
            </div>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={onAutoBalance}
            >
              Auto-balance (100%)
            </Button>
          </div>

          <div className="flex flex-col gap-3">
            {items.map((item, index) => (
              <div
                key={item.label}
                className={`flex flex-col gap-2 p-3.5 rounded-xl border transition-colors ${
                  item.enabled
                    ? "bg-card border-border/80 shadow-2xs"
                    : "bg-muted/20 border-border/40 opacity-60"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={item.enabled}
                      onChange={() => handleToggleEnable(index)}
                      className="size-4 rounded-md accent-primary cursor-pointer"
                    />
                    <span className="font-mono font-bold text-foreground text-sm">
                      {item.label}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={item.weight}
                      onChange={(e) => handleWeightChange(index, parseInt(e.target.value) || 0)}
                      disabled={!item.enabled}
                      className="w-16 h-8 text-center font-mono text-xs border rounded-md bg-background focus:outline-hidden focus:ring-1 focus:ring-primary disabled:opacity-50"
                    />
                    <span className="text-muted-foreground font-mono text-xs">%</span>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={item.weight}
                    onChange={(e) => handleWeightChange(index, parseInt(e.target.value) || 0)}
                    disabled={!item.enabled}
                    className="w-full accent-primary h-1.5 bg-muted rounded-lg appearance-none cursor-pointer disabled:cursor-not-allowed"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter className="p-4 border-t border-border/60 bg-muted/20">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={saving || !isValid}>
            {saving ? "Saving..." : "Save Traffic Split"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
