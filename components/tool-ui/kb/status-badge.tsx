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
        "inline-flex items-center gap-1.5 py-0.5 font-medium leading-none whitespace-nowrap min-w-0 max-w-full",
        className,
      )}
    >
      <span className="inline-flex items-center justify-center shrink-0 leading-none">
        <StatusIcon status={status} />
      </span>
      <span className="leading-none truncate min-w-0">{label}</span>
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
  embeddingPendingChunks,
  failedChunks,
  pendingChunks,
  parsingChunks,
  entityCount,
  relationshipCount,
  docStatus,
  className,
}: {
  totalChunks?: number;
  successChunks?: number;
  // ponytail: chunks whose status='success' but embedding IS NULL — OCR
  // is done but pgvector hasn't received the vector yet. Distinct from
  // pending/parsing (chunks not yet OCR'd). Distinct from failed.
  embeddingPendingChunks?: number;
  failedChunks?: number;
  pendingChunks?: number;
  parsingChunks?: number;
  // ponytail: hybrid-search has three legs (BM25/tsv, pgvector/embedding,
  // entity-tag overlap). "Indexed" requires at least one of entity or
  // relationship rows to exist — otherwise the doc is queryable by vector
  // but the entity-leg of hybrid search has nothing to score against.
  // entity/relationship counts drive the third intermediate "Embedding"
  // state (chunks all vectored but extraction still running).
  entityCount?: number;
  relationshipCount?: number;
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
          "inline-flex items-center gap-1.5 py-0.5 font-medium leading-none whitespace-nowrap min-w-0 max-w-full",
          className,
        )}
      >
        <Database className="size-3 shrink-0" />
        <span className="leading-none truncate min-w-0">Not Indexed</span>
      </Badge>
    );
  } else if (docStatus === "pending" || docStatus === "parsing") {
    tooltipText = "Indexing Status: Waiting for document OCR to finish";
    badgeElement = (
      <Badge
        variant="muted"
        className={cn(
          "inline-flex items-center gap-1.5 py-0.5 font-medium leading-none whitespace-nowrap min-w-0 max-w-full",
          className,
        )}
      >
        <Loader2 className="size-3 animate-spin shrink-0" />
        <span className="leading-none truncate min-w-0">Pending</span>
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
            "inline-flex items-center gap-1.5 py-0.5 font-medium leading-none text-muted-foreground border-dashed whitespace-nowrap min-w-0 max-w-full",
            className,
          )}
        >
          <Database className="size-3 shrink-0" />
          <span className="leading-none truncate min-w-0">No Chunks</span>
        </Badge>
      );
    } else {
      const embeddingPending = embeddingPendingChunks ?? 0;
      const entities = entityCount ?? 0;
      const relationships = relationshipCount ?? 0;
      // ponytail: hybrid-search has three legs (BM25/tsv, pgvector,
      // entity-tag overlap). "Indexed" is gated on vectors being
      // complete (success === total) — the graph leg is supplementary
      // and may legitimately produce zero rows for plain-text docs.
      // Forcing `hasGraph` here would leave such docs stuck on
      // "Embedding" forever with no terminal signal. The tooltip still
      // surfaces the entity/relationship counts so the user sees the
      // graph state explicitly.
      const terminal = success + failed + embeddingPending;
      const isCompleted = success === total;
      // ponytail: "X failed" only fires when every non-failed chunk has
      // actually finished OCR + embedding. If `embeddingPending > 0`,
      // those chunks are still in flight (vector hasn't landed yet) —
      // collapsing them into the "failed" bucket would render an
      // "X failed" badge for a doc that's really "X failed, Y still
      // embedding" and the user can't reconcile the count with the
      // tooltip breakdown.
      const isFailed = failed > 0 && embeddingPending === 0 && terminal === total;
      const hasInflightChunks = pending > 0 || parsing > 0;
      const hasInflightExtraction = entities === 0 && relationships === 0;
      const isInProgress = !isCompleted && !isFailed;

      let variant: "success" | "destructive" | "muted" = "muted";
      if (isFailed) {
        variant = "destructive";
      } else if (isCompleted) {
        variant = "success";
      }

      let label = "Indexed";
      let iconElement = <CheckCircle2 className="size-3" />;

      if (isInProgress) {
        // ponytail: three in-flight lanes collapse into two visible
        // labels — "Extracting" (chunks still being created by OCR /
        // chunk split) vs "Embedding" (chunks done but vector or
        // graph-extract still running). The X/Y numerator is the count
        // of chunks that have reached the *current lane's entry point*,
        // not just the fully-embedded ones — otherwise the label/total
        // don't sum to `total` and the user can't reconcile the badge
        // with the tooltip breakdown.
        if (hasInflightChunks) {
          // OCR / chunk-split in flight. X = OCR'd chunks = success +
          // embeddingPending. Y = total. Sums match the tooltip.
          const ocrDone = success + embeddingPending;
          label = `Extracting (${ocrDone}/${total})`;
          tooltipText = `Indexing Status: ${success} chunks embedded, ${embeddingPending} chunks awaiting vector, ${parsing} chunks in extraction, ${pending} chunks queued, ${failed} chunks failed`;
        } else {
          // OCR done; vector and/or graph extraction in flight. X =
          // embedded chunks. Y = total.
          label = `Embedding (${success}/${total})`;
          const vecBit = `${success} chunks embedded${embeddingPending > 0 ? `, ${embeddingPending} awaiting vector` : ""}`;
          const extBit = hasInflightExtraction
            ? `entity/relationship extraction in progress (${entities} entities, ${relationships} relationships so far)`
            : "";
          tooltipText = `Indexing Status: ${vecBit}${extBit ? ", " + extBit : ""}`;
        }
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
        // ponytail: surface the graph counts in the tooltip even when
        // the doc is "Indexed" — some docs legitimately produce zero
        // entities/relationships (plain text, sparse pages) and the
        // user should see that explicitly rather than wonder if the
        // extraction is still running.
        const graphBit = `${entities} entities, ${relationships} relationships`;
        tooltipText = `Indexing Status: Successfully indexed all ${total} chunks to vector database (${graphBit})`;
        iconElement = <Database className="size-3" />;
      }

      badgeElement = (
        <Badge
          variant={variant}
          className={cn(
            "inline-flex items-center gap-1.5 py-0.5 font-medium leading-none whitespace-nowrap min-w-0 max-w-full",
            className,
          )}
        >
          <span className="inline-flex items-center justify-center shrink-0 leading-none">
            {iconElement}
          </span>
          <span className="leading-none truncate min-w-0">{label}</span>
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
