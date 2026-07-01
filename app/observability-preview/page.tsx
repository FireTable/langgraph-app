// ponytail: server component reads two captured JSON files (one per
// USE_SUBGRAPH mode) and hands them to a side-by-side client wrapper so
// you can compare the parent chains directly. Skip withAuth — preview
// page is throwaway, rule #9 is for app/api/**.
import { CapturedPanels } from "@/components/assistant-ui/captured-panels.client";
import { toSpanData } from "@/components/assistant-ui/captured-to-span-data";
import type { CapturedSpan } from "@/backend/observability/callback-collector";
import type { SpanData } from "@assistant-ui/react-o11y";
import { readFileSync } from "node:fs";

type CapturedPayload = {
  spans: SpanData[];
  raw: CapturedSpan[];
};

function loadPayload(path: string): CapturedPayload | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as CapturedSpan[];
    if (!Array.isArray(raw) || raw.length === 0) return null;
    return { spans: toSpanData(raw), raw };
  } catch {
    return null;
  }
}

export default function PreviewPage() {
  const subgraph = loadPayload("/tmp/captured-spans-subgraph.json");
  const inlined = loadPayload("/tmp/captured-spans-inlined.json");
  return (
    <div className="min-h-screen bg-background p-8">
      <h1 className="mb-2 text-lg font-semibold">ObservabilityPanel preview</h1>
      <p className="text-muted-foreground mb-6 text-sm">
        Side-by-side comparison. Click <em>Open</em> on either panel to inspect spans.
      </p>
      <CapturedPanels subgraph={subgraph} inlined={inlined} />
    </div>
  );
}
