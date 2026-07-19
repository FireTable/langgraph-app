import { AlertCircle, CheckCircle2, FileText, Loader2, Database } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
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

export function DocStatusBadge({
  status,
  errorMessage,
  className,
}: {
  status: KbStatus;
  errorMessage: string | null;
  className?: string;
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

  let tooltipText = "Document Status: Pending page processing...";
  if (status === "success") {
    tooltipText = "Document Status: Successfully processed pages & extracted Markdown";
  } else if (status === "parsing") {
    tooltipText = "Document Status: Parsing PDF pages & running OCR...";
  } else if (status === "failed") {
    tooltipText = `Document Status: Failed parsing OCR. ${errorMessage ? `Error: ${errorMessage}` : ""}`;
  }

  const chip = (
    <Badge
      variant={variant}
      className={cn(
        "inline-flex items-center gap-1.5 py-0.5 font-medium leading-none whitespace-nowrap",
        className,
      )}
    >
      <span className="inline-flex items-center justify-center shrink-0 leading-none">
        <StatusIcon status={status} />
      </span>
      <span className="leading-none">{label}</span>
    </Badge>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-[300px] text-xs">
        {tooltipText}
      </TooltipContent>
    </Tooltip>
  );
}

export function ChunksStatusBadge({
  totalChunks,
  successChunks,
  failedChunks,
  docStatus,
  className,
}: {
  totalChunks?: number;
  successChunks?: number;
  failedChunks?: number;
  docStatus: KbStatus;
  className?: string;
}) {
  let tooltipText = "";
  let badgeElement: React.ReactElement | null = null;

  if (docStatus === "failed") {
    tooltipText = "Indexing Status: Skipped because the document OCR processing failed";
    badgeElement = (
      <Badge
        variant="muted"
        className={cn(
          "inline-flex items-center gap-1.5 py-0.5 font-medium leading-none whitespace-nowrap",
          className,
        )}
      >
        <Database className="size-3" />
        <span className="leading-none">Not Indexed</span>
      </Badge>
    );
  } else if (docStatus === "pending" || docStatus === "parsing") {
    tooltipText = "Indexing Status: Waiting for document OCR to finish";
    badgeElement = (
      <Badge
        variant="muted"
        className={cn(
          "inline-flex items-center gap-1.5 py-0.5 font-medium leading-none whitespace-nowrap",
          className,
        )}
      >
        <Loader2 className="size-3 animate-spin" />
        <span className="leading-none">Pending</span>
      </Badge>
    );
  } else {
    const total = totalChunks ?? 0;
    const success = successChunks ?? 0;
    const failed = failedChunks ?? 0;

    if (total === 0) {
      tooltipText = "Indexing Status: No chunks generated";
      badgeElement = (
        <Badge
          variant="muted"
          className={cn(
            "inline-flex items-center gap-1.5 py-0.5 font-medium leading-none text-muted-foreground bg-muted/10 border-dashed whitespace-nowrap",
            className,
          )}
        >
          <Database className="size-3" />
          <span className="leading-none">No Chunks</span>
        </Badge>
      );
    } else {
      const isCompleted = success === total;
      const isFailed = failed > 0 && success + failed === total;
      const isIndexing = !isCompleted && !isFailed;

      let variant: "success" | "destructive" | "muted" = "muted";
      if (isFailed) {
        variant = "destructive";
      } else if (isCompleted) {
        variant = "success";
      }

      let label = "Indexed";
      let iconElement = <CheckCircle2 className="size-3" />;

      if (isIndexing) {
        label = `Indexing (${success}/${total})`;
        tooltipText = `Indexing Status: Embedding chunks (${success}/${total} processed, ${failed} failed)...`;
        const radius = 4.5;
        const circumference = 2 * Math.PI * radius;
        const pct = total > 0 ? success / total : 0;
        const strokeDashoffset = circumference - pct * circumference;
        iconElement = (
          <svg className="size-3 -rotate-90 shrink-0" viewBox="0 0 12 12">
            <circle
              className="stroke-muted-foreground/20"
              strokeWidth="1.8"
              fill="transparent"
              r={radius}
              cx="6"
              cy="6"
            />
            <circle
              className="stroke-primary transition-all duration-300 animate-pulse"
              strokeWidth="1.8"
              fill="transparent"
              r={radius}
              cx="6"
              cy="6"
              strokeDasharray={circumference}
              strokeDashoffset={strokeDashoffset}
              strokeLinecap="round"
            />
          </svg>
        );
      } else if (isFailed) {
        label = `${failed} failed`;
        tooltipText = `Indexing Status: Vector database ingestion failed for ${failed} out of ${total} chunks`;
        iconElement = <AlertCircle className="size-3" />;
      } else {
        tooltipText = `Indexing Status: Successfully indexed all ${total} chunks to vector database`;
        iconElement = <Database className="size-3" />;
      }

      badgeElement = (
        <Badge
          variant={variant}
          className={cn(
            "inline-flex items-center gap-1.5 py-0.5 font-medium leading-none whitespace-nowrap",
            className,
          )}
        >
          <span className="inline-flex items-center justify-center shrink-0 leading-none">
            {iconElement}
          </span>
          <span className="leading-none">{label}</span>
        </Badge>
      );
    }
  }

  if (!badgeElement) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{badgeElement}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-[300px] text-xs">
        {tooltipText}
      </TooltipContent>
    </Tooltip>
  );
}

export function StatusBadge({
  status,
  errorMessage,
}: {
  status: KbStatus;
  errorMessage: string | null;
}) {
  return <DocStatusBadge status={status} errorMessage={errorMessage} />;
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
