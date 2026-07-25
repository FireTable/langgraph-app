"use client";

import React from "react";
import { Sliders } from "lucide-react";
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

  return (
    <Dialog open={Boolean(agentId)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sliders className="size-4 text-primary" /> Traffic Weight Allocation
          </DialogTitle>
          <DialogDescription className="text-xs">
            Configure A/B test traffic percentages for target node{" "}
            <span className="font-mono font-semibold text-foreground">{agentId}</span>.
            Sum of active traffic weights must equal exactly 100%.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-3 text-xs">
          <div className="flex items-center justify-between bg-muted/30 p-2.5 rounded-lg border">
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground">Traffic Sum:</span>
              <Badge
                variant={isValid ? "default" : "destructive"}
                className="font-mono text-xs"
              >
                {activeSum}% {isValid ? "✓ Valid" : "✗ Must equal 100%"}
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

          <div className="flex flex-col gap-2.5 max-h-[300px] overflow-y-auto pr-1">
            {items.map((item, idx) => (
              <div
                key={item.variantId}
                className="flex items-center justify-between gap-3 bg-card p-3 rounded-lg border"
              >
                <div className="flex items-center gap-2.5">
                  <input
                    type="checkbox"
                    checked={item.enabled}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setItems((prev) =>
                        prev.map((i, iIdx) => (iIdx === idx ? { ...i, enabled: checked } : i)),
                      );
                    }}
                    className="size-4 rounded-xs border-border accent-primary cursor-pointer"
                  />
                  <div className="flex flex-col">
                    <span className="font-semibold text-foreground">{item.label}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {item.variantId} ({item.templateId})
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min="0"
                    max="100"
                    disabled={!item.enabled}
                    value={item.enabled ? item.weight : 0}
                    onChange={(e) => {
                      const val = parseInt(e.target.value) || 0;
                      setItems((prev) =>
                        prev.map((i, iIdx) => (iIdx === idx ? { ...i, weight: val } : i)),
                      );
                    }}
                    className="h-1.5 w-32 cursor-pointer accent-primary rounded-lg bg-muted disabled:opacity-30"
                  />
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      min="0"
                      max="100"
                      disabled={!item.enabled}
                      value={item.enabled ? item.weight : 0}
                      onChange={(e) => {
                        const val = parseInt(e.target.value) || 0;
                        setItems((prev) =>
                          prev.map((i, iIdx) => (iIdx === idx ? { ...i, weight: val } : i)),
                        );
                      }}
                      className="h-8 w-16 font-mono text-center text-xs"
                    />
                    <span className="font-mono text-muted-foreground text-xs">%</span>
                  </div>
                </div>
              </div>
            ))}
            {items.length === 0 && (
              <div className="text-center py-6 text-muted-foreground italic">
                No variants created for {agentId} yet. Add a variant or prompt version first!
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={onSave}
            disabled={saving || items.length === 0 || !isValid}
          >
            {saving ? "Saving..." : "Save Traffic Split"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
