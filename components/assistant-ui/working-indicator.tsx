"use client";

import { DotMatrix } from "@/components/assistant-ui/dot-matrix";
import { useAuiState } from "@assistant-ui/react";
import type { FC } from "react";

/**
 * Renders the placeholder shown while an assistant message has not yet
 * received any content. Two phases:
 *
 * - `isEmpty` (no parts arrived yet): 5×5 dot matrix in `connecting` state
 *   with a "Connecting" label. Replaces the model-prep DotMatrix so the user
 *   gets a stronger pre-first-token signal.
 * - After the first part arrives: a single pulsing dot, since the stream
 *   is now in flight and the larger affordance would be redundant.
 */
export const WorkingIndicator: FC = () => {
  const isEmpty = useAuiState((s) => s.message.content.length === 0);

  if (isEmpty) {
    return (
      <span
        data-slot="aui_assistant-message-indicator-connecting"
        className="text-muted-foreground inline-flex items-center gap-2 align-middle"
      >
        <DotMatrix state="connecting" aria-hidden />
        <span className="text-sm">Connecting</span>
      </span>
    );
  }

  return (
    <span
      data-slot="aui_assistant-message-indicator-working"
      className="animate-pulse font-sans"
      aria-label="Assistant is working"
    >
      <DotMatrix state="connecting" aria-hidden />
    </span>
  );
};
