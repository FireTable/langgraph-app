import { AlertCircle, CheckCircle2, Database, FileText, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// ponytail: shared between the Settings → KB rows and the chat-side
// list_documents card. Same shape, same tooltip text — the settings
// version was the source of truth and the chat card was the second
// consumer, so the file moved to a shared location rather than be
// duplicated. KbStatus is inlined (rather than imported from the
// settings view) so tool-ui doesn't depend on settings.

export type KbStatus = "pending" | "parsing" | "success" | "failed";

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
  totalPages,
  successPages,
  failedPages,
  parsingPages,
  pendingPages,
  className,
}: {
  status: KbStatus;
  errorMessage: string | null;
  totalPages?: number;
  successPages?: number;
  failedPages?: number;
  parsingPages?: number;
  pendingPages?: number;
  className?: string;
}) {
  const variant: "success" | "destructive" | "muted" =
    status === "success" ? "success" : status === "failed" ? "destructive" : "muted";
  let label =
    status === "success"
      ? "Ready"
      : status === "parsing"
        ? "Parsing"
        : status === "failed"
          ? "Failed"
          : "Pending";

  if (status === "parsing" && totalPages !== undefined && totalPages > 0) {
    const success = successPages ?? 0;
    label = `Parsing (${success}/${totalPages})`;
  } else if (status === "pending" && totalPages !== undefined && totalPages > 0) {
    label = `Pending (0/${totalPages})`;
  }

  let tooltipText = "Document Status: Pending page processing...";
  if (status === "success") {
    tooltipText = `Document Status: Successfully processed pages & extracted Markdown (${successPages ?? totalPages ?? "?"}/${totalPages ?? "?"} pages succeeded)`;
  } else if (status === "parsing") {
    const done = successPages ?? 0;
    const inFlight = parsingPages ?? 0;
    const waiting = pendingPages ?? 0;
    const failed = failedPages ?? 0;
    tooltipText = `Document Status: Parsing PDF pages & running OCR (${done}/${totalPages ?? "?"} done, ${inFlight} in flight, ${waiting} waiting, ${failed} failed)`;
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
  pendingChunks,
  parsingChunks,
  docStatus,
  className,
}: {
  totalChunks?: number;
  successChunks?: number;
  failedChunks?: number;
  pendingChunks?: number;
  parsingChunks?: number;
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
    const parsing = parsingChunks ?? 0;
    const pending = pendingChunks ?? 0;

    if (total === 0) {
      tooltipText = "Indexing Status: No chunks generated";
      badgeElement = (
        <Badge
          variant="muted"
          className={cn(
            "inline-flex items-center gap-1.5 py-0.5 font-medium leading-none text-muted-foreground border-dashed whitespace-nowrap",
            className,
          )}
        >
          <Database className="size-3" />
          <span className="leading-none">No Chunks</span>
        </Badge>
      );
    } else {
      const terminal = success + failed;
      const isCompleted = success === total;
      const isFailed = failed > 0 && terminal === total;
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
        tooltipText = `Indexing Status: ${success} chunks embedded, ${parsing} chunks in LLM extraction, ${pending} chunks queued, ${failed} chunks failed`;
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
