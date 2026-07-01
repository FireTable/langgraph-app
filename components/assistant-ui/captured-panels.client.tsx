"use client";

// ponytail: client wrapper for the preview page — owns function props
// (onOpenChange) that can't cross the server/client boundary. Two panels
// rendered side-by-side for subgraph-vs-inlined comparison; each panel
// controls its own Sheet state via local useState so they open and close
// independently.
import { useState, type FC } from "react";
import { ObservabilityPanel } from "@/components/assistant-ui/observability-panel";
import { mockSpans } from "@/components/assistant-ui/mock-spans";
import type { CapturedSpan } from "@/backend/observability/callback-collector";
import type { SpanData } from "@assistant-ui/react-o11y";

type CapturedPayload = {
  spans: SpanData[];
  raw: CapturedSpan[];
};

type PanelBlockProps = {
  title: string;
  source: "mock" | "captured";
  data: CapturedPayload;
};

const PanelBlock: FC<PanelBlockProps> = ({ title, source, data }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-border rounded-lg border p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        <button
          onClick={() => setOpen(true)}
          className="border-border bg-accent text-foreground rounded border px-2 py-1 text-xs"
        >
          Open
        </button>
      </div>
      <p className="text-muted-foreground mb-1 text-xs">
        Source: <code className="bg-muted rounded px-1">{source}</code>.{" "}
        {source === "captured" ? `${data.spans.length} spans.` : "15 mock spans."}
      </p>
      <ObservabilityPanel
        open={open}
        onOpenChange={setOpen}
        spans={source === "mock" ? mockSpans : data.spans}
        rawSpans={source === "captured" ? data.raw : undefined}
      />
    </div>
  );
};

export const CapturedPanels: FC<{
  subgraph: CapturedPayload | null;
  inlined: CapturedPayload | null;
}> = ({ subgraph, inlined }) => (
  <div className="grid grid-cols-2 gap-4">
    <PanelBlock
      title="USE_SUBGRAPH=true"
      source={subgraph ? "captured" : "mock"}
      data={subgraph ?? { spans: mockSpans, raw: [] }}
    />
    <PanelBlock
      title="USE_SUBGRAPH=false (inlined)"
      source={inlined ? "captured" : "mock"}
      data={inlined ?? { spans: mockSpans, raw: [] }}
    />
  </div>
);
