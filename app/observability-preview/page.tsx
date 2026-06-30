"use client";

import { ObservabilityPanel } from "@/components/assistant-ui/observability-panel";
import { mockSpans } from "@/components/assistant-ui/mock-spans";
import type { FC } from "react";

const Preview: FC = () => {
  return (
    <div className="min-h-screen bg-background p-8">
      <h1 className="mb-2 text-lg font-semibold">ObservabilityPanel preview</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        15 mock spans across three root API calls. Sticky label column, SVG bars colored by type,
        running span animates and grows via{" "}
        <code className="rounded bg-muted px-1">requestAnimationFrame</code>, failed span gets a red
        stroke.
      </p>
      <ObservabilityPanel open onOpenChange={() => {}} spans={mockSpans} />
    </div>
  );
};

export default Preview;
