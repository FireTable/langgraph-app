"use client";

// ponytail: rule #8 exception — icon-only (`size="icon"`) is allowed
// since there's no label to attach. This button is JUST an icon — no
// Sheet, no fetch, no panel. The singleton <ObservabilitySheet/>
// mounted at ThreadRoot owns all of that. Click → ask the context to
// open against the active thread.
import { type FC } from "react";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { useAuiState } from "@assistant-ui/react";
import { ActivityIcon } from "lucide-react";
import { useOpenObservabilitySheet } from "@/components/observability/sheet-context";

const LOCAL_THREAD_PREFIX = "__LOCAL_";

export const ObservabilityButton: FC = () => {
  const openSheet = useOpenObservabilitySheet();

  const threadId = useAuiState((s) => {
    const item = s.threads.threadItems.find((t) => t.id === s.threads.mainThreadId);
    const candidate = item?.externalId ?? s.threads.mainThreadId;
    return candidate && !candidate.startsWith(LOCAL_THREAD_PREFIX) ? candidate : null;
  });

  const message = useAuiState((s) => s.message);
  if (!threadId) return null;

  return (
    <TooltipIconButton
      tooltip="Observability"
      side="bottom"
      variant="ghost"
      size="icon"
      className="aui-observability-action size-6"
      aria-label="Open observability panel"
      onClick={() => {
        // ponytail: message is the assistant message this button is mounted
        // on; message.parentId is the human message that triggered it
        // (assistant-ui convention). The backend tags every span with
        // that same parent_message_id, so the Sheet filters to the spans
        // produced for THIS turn only.
        openSheet({ threadId, parentMessageId: message?.parentId ?? null });
      }}
    >
      <ActivityIcon className="size-4" />
    </TooltipIconButton>
  );
};
