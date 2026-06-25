"use client";

import { AuiProvider, useAui, useAuiState } from "@assistant-ui/react";
import { SpanPrimitive, SpanResource, type SpanData } from "@assistant-ui/react-o11y";
import type { FC } from "react";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

export type ObservabilityPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spans: SpanData[];
};

const SpanRow: FC = () => {
  const span = useAuiState((s) => s.span);
  return (
    <div className="border-border/60 mb-1 rounded border p-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{span.name}</span>
        <span className="text-muted-foreground">{span.status}</span>
      </div>
      {span.latencyMs != null && <div className="text-muted-foreground">{span.latencyMs}ms</div>}
    </div>
  );
};

export const ObservabilityPanel: FC<ObservabilityPanelProps> = ({ open, onOpenChange, spans }) => {
  const aui = useAui({ span: SpanResource({ spans }) });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-96 flex-col gap-4 overflow-y-auto p-6">
        <SheetHeader>
          <SheetTitle>Observability</SheetTitle>
        </SheetHeader>
        <AuiProvider value={aui}>
          {spans.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No spans yet. Send a message to record activity.
            </p>
          ) : (
            <SpanPrimitive.Root>
              <SpanPrimitive.Children components={{ Span: SpanRow }} />
            </SpanPrimitive.Root>
          )}
        </AuiProvider>
      </SheetContent>
    </Sheet>
  );
};
