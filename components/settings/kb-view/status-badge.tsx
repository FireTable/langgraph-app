import { AlertCircle, CheckCircle2, FileText, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import {
  DocStatusBadge,
  ChunksStatusBadge,
  type KbStatus,
} from "@/components/tool-ui/kb/status-badge";

export { DocStatusBadge, ChunksStatusBadge, type KbStatus };

// ponytail: ChunkStatusBadge is per-chunk and only renders in the
// doc-detail dialog's Chunks tab. It stayed in the settings view
// because the chat-side list_documents card only needs per-doc
// status, not per-chunk.
export function ChunkStatusBadge({
  status,
  errorMessage,
}: {
  status: KbStatus;
  errorMessage: string | null;
}) {
  // ponytail: match the Pages tab's "Succeeded"/"Failed"/"Parsing…"/"Pending"
  // badge shape exactly — same variant, same dimensions
  // (text-[9px] py-0 px-1.5), same label text. Without this, the
  // Pages "SUCCEEDED" pill and the Chunks "SUCCESS" pill looked like
  // two different status indicators even though they meant the same
  // thing.
  const variant: "success" | "destructive" | "muted" =
    status === "success" ? "success" : status === "failed" ? "destructive" : "muted";
  const label =
    status === "success"
      ? "Succeeded"
      : status === "failed"
        ? "Failed"
        : status === "parsing"
          ? "Parsing…"
          : "Pending";
  const content = (
    <Badge variant={variant} className="text-[9px] py-0 px-1.5 font-medium leading-none">
      {label}
    </Badge>
  );
  if (status === "failed" && errorMessage) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="top">{errorMessage}</TooltipContent>
      </Tooltip>
    );
  }
  return content;
}

export function StatusIcon({ status }: { status: KbStatus }) {
  switch (status) {
    case "success":
      return <CheckCircle2 className="size-3" aria-hidden />;
    case "failed":
      return <AlertCircle className="size-3" aria-hidden />;
    case "parsing":
    case "pending":
      return <Loader2 className="size-3 animate-spin" aria-hidden />;
    default:
      return <FileText className="size-3" aria-hidden />;
  }
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
