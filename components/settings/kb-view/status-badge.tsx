import { AlertCircle, CheckCircle2, FileText, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { KbStatus, KbChunkPreviewLocal } from "./types";

export function ChunkStatusBadge({
  status,
  errorMessage,
}: {
  status: KbChunkPreviewLocal["status"];
  errorMessage: string | null;
}) {
  const variant: "success" | "destructive" | "muted" =
    status === "success" ? "success" : status === "failed" ? "destructive" : "muted";
  const label =
    status === "parsing" ? "Indexing" : status.charAt(0).toUpperCase() + status.slice(1);
  const content = (
    <Badge
      variant={variant}
      className="inline-flex items-center gap-1 py-0.5 font-medium leading-none"
    >
      <span className="leading-none">{label}</span>
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

export function StatusBadge({
  status,
  errorMessage,
}: {
  status: KbStatus;
  errorMessage: string | null;
}) {
  const variant: "success" | "destructive" | "muted" =
    status === "success" ? "success" : status === "failed" ? "destructive" : "muted";
  const label =
    status === "success"
      ? "Ready"
      : status === "parsing"
        ? "Parsing"
        : status === "failed"
          ? "Failed"
          : "Pending";
  const chip = (
    <Badge
      variant={variant}
      className="inline-flex items-center gap-1 py-0.5 font-medium leading-none"
    >
      <span className="inline-flex items-center justify-center shrink-0 leading-none">
        <StatusIcon status={status} />
      </span>
      <span className="leading-none">{label}</span>
    </Badge>
  );
  if (status === "failed" && errorMessage) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{chip}</TooltipTrigger>
        <TooltipContent side="top">{errorMessage}</TooltipContent>
      </Tooltip>
    );
  }
  return chip;
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
