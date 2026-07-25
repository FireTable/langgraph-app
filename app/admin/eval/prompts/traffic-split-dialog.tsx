"use client";

import React from "react";
import { Check } from "lucide-react";
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
            Set Traffic Weight
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Configure A/B test traffic percentages across all agent nodes. Sum of active traffic weights must equal exactly 100%.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 p-6 overflow-y-auto max-h-[60vh] text-xs">
          {/* Status Bar */}
          <div className="flex items-center justify-between bg-muted/40 px-3.5 py-2.5 rounded-xl border border-border/60">
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground text-xs">Traffic Sum:</span>
              <Badge
                variant={isValid ? "default" : "destructive"}
                className="font-mono text-xs px-2.5 py-0.5"
              >
                {activeSum}% {isValid ? "✓ VALID" : "✗ Must equal 100%"}
              </Badge>
            </div>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={onAutoBalance}
              className="h-7 text-xs font-medium"
            >
              Auto-balance (100%)
            </Button>
          </div>

          {/* Variant Weight Cards */}
          <div className="flex flex-col gap-3">
            {items.map((item, index) => (
              <div
                key={item.label}
                className={`flex flex-col gap-3 p-4 rounded-xl border transition-all ${
                  item.enabled
                    ? "bg-card border-border/80 shadow-2xs"
                    : "bg-muted/10 border-border/40 opacity-50"
                }`}
              >
                <div className="flex items-center justify-between">
                  {/* Custom Checkbox */}
                  <div
                    onClick={() => handleToggleEnable(index)}
                    className="flex items-center gap-2.5 cursor-pointer select-none"
                  >
                    <div
                      className={`size-4.5 rounded-md border flex items-center justify-center transition-colors ${
                        item.enabled
                          ? "bg-primary border-primary text-primary-foreground"
                          : "border-input bg-background"
                      }`}
                    >
                      {item.enabled && <Check className="size-3 stroke-[3]" />}
                    </div>
                    <span className="font-mono font-bold text-foreground text-sm flex items-center gap-1.5">
                      {item.label}
                    </span>
                  </div>

                  {/* Input Box */}
                  <div className="flex items-center gap-1.5 bg-muted/40 border border-border/60 rounded-lg px-2.5 py-1">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={item.weight}
                      onChange={(e) => handleWeightChange(index, parseInt(e.target.value) || 0)}
                      disabled={!item.enabled}
                      className="w-12 text-center font-mono font-bold text-xs bg-transparent focus:outline-none disabled:opacity-50"
                    />
                    <span className="text-muted-foreground font-mono text-xs select-none">%</span>
                  </div>
                </div>

                {/* Custom Gradient Slider */}
                <div className="relative flex items-center w-full pt-1">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={item.weight}
                    onChange={(e) => handleWeightChange(index, parseInt(e.target.value) || 0)}
                    disabled={!item.enabled}
                    style={{
                      background: item.enabled
                        ? `linear-gradient(to right, var(--primary) 0%, var(--primary) ${item.weight}%, var(--muted) ${item.weight}%, var(--muted) 100%)`
                        : "var(--muted)",
                    }}
                    className="w-full h-2 rounded-lg appearance-none cursor-pointer disabled:cursor-not-allowed accent-primary focus:outline-none"
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
            {saving ? "Saving..." : "Save Traffic Weight"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
