"use client";

import { DotMatrix } from "@/components/assistant-ui/dot-matrix";
import type { FC } from "react";

/**
 * Single pulsing dot shown while an assistant message is in flight.
 * Optional `text` adds a label (e.g. for tool UIs narrating their state).
 */
export const WorkingIndicator: FC<{
  text?: string;
}> = ({ text }) => {
  return (
    <span
      data-slot="aui_assistant-message-indicator-working"
      className="animate-pulse inline-flex items-center gap-2 align-middle"
      aria-label="Assistant is working"
    >
      <DotMatrix state="connecting" aria-hidden />
      {text ? <span className="text-sm">{text}</span> : null}
    </span>
  );
};
