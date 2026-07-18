import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  ArrowDown,
  ArrowRight,
  Blocks,
  Check,
  Copy,
  ExternalLink,
  Eye,
  FileImage,
  FileText,
  Hash,
  Link2,
  Loader2,
  Network,
  ScanText,
  Tags,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { TOAST_DESCRIPTION_CLASS } from "./helpers";
import { ChunkStatusBadge, StatusBadge } from "./status-badge";
import { KbDocDetail, KbChunkPreviewLocal } from "./types";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground italic">
      Loading visual map...
    </div>
  ),
});

export function DocDetailDialog({
  docId,
  open,
  onOpenChange,
  onRefresh,
}: {
  docId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRefresh: () => Promise<void> | void;
}) {
  const [detail, setDetail] = useState<KbDocDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"full_markdown" | "pages" | "chunks" | "graph">(
    "full_markdown",
  );
  const [graphView, setGraphView] = useState<"visual" | "themes" | "entities" | "relationships">(
    "visual",
  );
  const [copied, setCopied] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 600, height: 500 });

  useEffect(() => {
    if (activeTab !== "graph" || !containerRef.current) return;
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width } = entry.contentRect;
        setDimensions({ width: width || 600, height: 500 });
      }
    });
    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, [containerRef, activeTab]);

  const { uniqueThemes, uniqueEntities, uniqueRelationships, graphData } = useMemo(() => {
    if (!detail || !detail.chunks) {
      return {
        uniqueThemes: [],
        uniqueEntities: [],
        uniqueRelationships: [],
        graphData: { nodes: [], links: [] },
      };
    }
    const themesSet = new Set<string>();
    const entityMap = new Map<string, { name: string; type: string; description: string }>();
    const relMap = new Map<
      string,
      { source: string; target: string; relation: string; description: string }
    >();

    for (const c of detail.chunks) {
      if (c.themes) {
        for (const t of c.themes) {
          themesSet.add(t);
        }
      }
      if (c.entities) {
        for (const e of c.entities) {
          const key = e.name.toLowerCase();
          const existing = entityMap.get(key);
          if (!existing || e.description.length > existing.description.length) {
            entityMap.set(key, e);
          }
        }
      }
      if (c.relationships) {
        for (const r of c.relationships) {
          const key = `${r.source.toLowerCase()}->${r.target.toLowerCase()}:${r.relation.toLowerCase()}`;
          const existing = relMap.get(key);
          if (!existing || r.description.length > existing.description.length) {
            relMap.set(key, r);
          }
        }
      }
    }

    const sortedThemes = Array.from(themesSet).sort();
    const sortedEntities = Array.from(entityMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    const sortedRelationships = Array.from(relMap.values()).sort((a, b) =>
      a.source.localeCompare(b.source),
    );

    // Calculate degree for scaling node visual size
    const degrees: Record<string, number> = {};
    for (const r of sortedRelationships) {
      const src = r.source.toLowerCase();
      const tgt = r.target.toLowerCase();
      degrees[src] = (degrees[src] || 0) + 1;
      degrees[tgt] = (degrees[tgt] || 0) + 1;
    }

    const nodes = sortedEntities.map((e) => {
      const degree = degrees[e.name.toLowerCase()] || 0;
      return { id: e.name, name: e.name, type: e.type, description: e.description, degree };
    });

    const links = sortedRelationships.map((r) => ({
      source: r.source,
      target: r.target,
      relation: r.relation,
      description: r.description,
    }));

    return {
      uniqueThemes: sortedThemes,
      uniqueEntities: sortedEntities,
      uniqueRelationships: sortedRelationships,
      graphData: { nodes, links },
    };
  }, [detail]);

  // Reset graphView on tab change
  useEffect(() => {
    if (activeTab !== "graph") {
      setGraphView("visual");
    }
  }, [activeTab]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    void fetch(`/api/kb/documents/${docId}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((body: KbDocDetail) => {
        if (!controller.signal.aborted) setDetail(body);
      })
      .catch((err) => {
        if (err?.name !== "AbortError") setDetail(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, docId]);

  useEffect(() => {
    if (!open) return;
    if (!detail) return;
    const docInflight = detail.doc.status === "pending" || detail.doc.status === "parsing";
    const chunksInflight = detail.chunks.some(
      (c) => c.status === "pending" || c.status === "parsing",
    );
    if (!docInflight && !chunksInflight && detail.chunks.length > 0) return;
    const controller = new AbortController();
    const t = setInterval(() => {
      void fetch(`/api/kb/documents/${docId}`, { signal: controller.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((body: KbDocDetail | null) => {
          if (!controller.signal.aborted && body) setDetail(body);
        })
        .catch((err) => {
          if (err?.name !== "AbortError") {
            console.error("DocDetailDialog poll failed", err);
          }
        });
    }, 2000);
    return () => {
      controller.abort();
      clearInterval(t);
    };
  }, [open, docId, detail]);

  const handleCopy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  const fullMarkdown = useMemo(() => {
    if (!detail) return "";
    if (detail.doc.pages && detail.doc.pages.length > 0) {
      return detail.doc.pages
        .map((p: any) => p.markdown)
        .filter((m) => typeof m === "string" && m.length > 0)
        .join("\n\n");
    }
    return detail.chunks.map((c) => c.content).join("\n\n");
  }, [detail]);

  const isPolling = useMemo(() => {
    if (!detail) return false;
    const docInflight = detail.doc.status === "pending" || detail.doc.status === "parsing";
    const chunksInflight = detail.chunks.some(
      (c) => c.status === "pending" || c.status === "parsing",
    );
    return (
      docInflight ||
      chunksInflight ||
      (detail.chunks.length === 0 && detail.doc.status === "success")
    );
  }, [detail]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          setDetail(null);
          setActiveTab("full_markdown");
        }
      }}
    >
      <DialogContent className="w-[95vw] max-w-[95vw] md:w-[75vw] md:max-w-[75vw]">
        <DialogHeader className="min-w-0 max-w-3xl flex-1">
          <div className="flex items-start justify-between gap-3 min-w-0">
            <DialogTitle className="truncate min-w-0 max-w-[80%]">
              {detail?.doc.title ?? "Loading…"}
            </DialogTitle>
            {detail?.doc.attachmentUrl && (
              <Button asChild size="sm" variant="outline" className="shrink-0 gap-1.5">
                <a href={detail.doc.attachmentUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="size-3.5" />
                  Open source
                </a>
              </Button>
            )}
          </div>
          <DialogDescription asChild>
            {detail ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs select-none">
                <StatusBadge status={detail.doc.status} errorMessage={detail.doc.errorMessage} />
                <span className="size-1 rounded-full bg-muted-foreground/30 shrink-0" aria-hidden />

                <Badge
                  variant="outline"
                  className="border-none bg-transparent text-muted-foreground shadow-none px-0 py-0.5 font-normal leading-none"
                >
                  <span>{detail.doc.contentType}</span>
                </Badge>

                {detail.doc.pages && detail.doc.pages.length > 0 && (
                  <>
                    <span
                      className="size-1 rounded-full bg-muted-foreground/30 shrink-0"
                      aria-hidden
                    />
                    <Badge
                      variant="outline"
                      className="border-none bg-transparent text-muted-foreground shadow-none px-0 py-0.5 font-normal leading-none"
                    >
                      <span>{detail.doc.pages.length} pages</span>
                    </Badge>
                  </>
                )}

                {detail.chunks.length > 0 && (
                  <>
                    <span
                      className="size-1 rounded-full bg-muted-foreground/30 shrink-0"
                      aria-hidden
                    />
                    <Badge
                      variant="outline"
                      className="border-none bg-transparent text-muted-foreground shadow-none px-0 py-0.5 font-normal leading-none"
                    >
                      <span>{detail.chunks.length} chunks</span>
                    </Badge>
                  </>
                )}

                {isPolling && (
                  <>
                    <span
                      className="size-1 rounded-full bg-muted-foreground/30 shrink-0"
                      aria-hidden
                    />
                    <div className="flex items-center gap-1 text-muted-foreground select-none leading-none h-4">
                      <Loader2 className="size-3 animate-spin text-muted-foreground/60 shrink-0" />
                      <span className="text-[10px] text-muted-foreground/60 font-medium">
                        Indexing…
                      </span>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="h-4" />
            )}
          </DialogDescription>
        </DialogHeader>

        {detail && (
          <div className="flex h-9 items-center justify-start rounded-lg bg-muted p-1 text-muted-foreground w-full sm:w-fit overflow-x-auto shrink-0 select-none">
            <button
              onClick={() => setActiveTab("full_markdown")}
              className={cn(
                "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-xs font-semibold transition-all duration-200 h-7 flex-1 sm:flex-initial",
                activeTab === "full_markdown"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <FileText className="size-3.5 sm:mr-1.5 shrink-0" />
              <span className="hidden sm:inline">Markdown</span>
            </button>
            <button
              onClick={() => setActiveTab("pages")}
              className={cn(
                "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-xs font-semibold transition-all duration-200 h-7 flex-1 sm:flex-initial",
                activeTab === "pages"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <ScanText className="size-3.5 sm:mr-1.5 shrink-0" />
              <span className="hidden sm:inline">Pages ({detail.doc.pages?.length ?? 0})</span>
            </button>
            <button
              onClick={() => setActiveTab("chunks")}
              className={cn(
                "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-xs font-semibold transition-all duration-200 h-7 flex-1 sm:flex-initial",
                activeTab === "chunks"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Blocks className="size-3.5 sm:mr-1.5 shrink-0" />
              <span className="hidden sm:inline">Chunks ({detail.chunks.length})</span>
            </button>
            <button
              onClick={() => setActiveTab("graph")}
              className={cn(
                "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-xs font-semibold transition-all duration-200 h-7 flex-1 sm:flex-initial",
                activeTab === "graph"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Network className="size-3.5 sm:mr-1.5 shrink-0" />
              <span className="hidden sm:inline">Graph</span>
            </button>
          </div>
        )}

        <div className="max-h-[75vh] space-y-4 overflow-y-auto pr-1 min-h-[300px] flex flex-col justify-start min-w-0">
          {loading ? (
            <div className="space-y-3 w-full flex-1">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : !detail ? (
            <p className="text-muted-foreground text-sm">Failed to load.</p>
          ) : activeTab === "full_markdown" ? (
            <div className="relative flex-1 flex flex-col border rounded-xl bg-muted/10 overflow-hidden min-h-[300px]">
              <div className="flex items-center justify-between border-b px-4 py-2 bg-muted/40 shrink-0">
                <span className="text-[11px] font-semibold capitalize tracking-wider text-muted-foreground">
                  Markdown
                </span>
                {fullMarkdown && (
                  <button
                    onClick={() => handleCopy(fullMarkdown)}
                    className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-semibold text-muted-foreground hover:text-foreground hover:bg-muted rounded border bg-background transition-all"
                  >
                    {copied ? (
                      <>
                        <Check className="size-3.5 text-green-500" />
                        <span className="text-green-500 text-[10px] font-semibold">Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="size-3.5" />
                        <span className="text-[10px] font-semibold">Copy</span>
                      </>
                    )}
                  </button>
                )}
              </div>
              <div className="p-4 flex-1 overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-foreground/90 max-h-[50vh]">
                {fullMarkdown || (
                  <span className="text-muted-foreground italic">No text extracted yet.</span>
                )}
              </div>
            </div>
          ) : activeTab === "pages" ? (
            // Tab 2: Pages — left (image + ref) → right (markdown)
            detail.doc.pages && detail.doc.pages.length > 0 ? (
              <div className="space-y-4 w-full">
                {detail.doc.pages.map((p) => {
                  const page = p as {
                    pageIndex: number;
                    imageUrl: string;
                    markdown: string;
                    referenceText?: string;
                  };
                  const hasRef = !!page.referenceText?.trim();
                  return (
                    <div
                      key={page.pageIndex}
                      className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm transition-all duration-200 hover:shadow-md"
                    >
                      {/* Card Header */}
                      <div className="flex items-center border-b px-4 py-2.5 bg-muted/40">
                        <span className="text-[11px] font-semibold capitalize tracking-wider text-muted-foreground">
                          Page #{page.pageIndex + 1}
                        </span>
                      </div>

                      {/* Body: [Image + Ref] → [Markdown] */}
                      <div className="flex flex-col gap-4 p-4 md:grid md:grid-cols-[1fr_auto_2fr] md:items-stretch md:gap-0">
                        {/* Left 1/3: Image stacked above "+" and Reference Text */}
                        <div className="flex h-full min-h-0 flex-col justify-between gap-2 w-full md:w-auto">
                          {/* Page Image */}
                          <div className="flex flex-col gap-1">
                            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 flex items-center gap-1">
                              <FileImage className="size-3" />
                              Page Image
                            </span>
                            <a
                              href={page.imageUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex h-full min-h-[180px] max-h-[180px] items-center justify-center group overflow-hidden rounded-lg border bg-muted shadow-sm transition-shadow hover:shadow-md cursor-zoom-in"
                              title="Click to view full size"
                            >
                              <img
                                src={page.imageUrl}
                                alt={`Page ${page.pageIndex + 1}`}
                                className="max-h-full max-w-full object-contain transition-transform duration-300 group-hover:scale-[1.02]"
                                loading="lazy"
                              />
                            </a>
                          </div>

                          {/* + connector — matches ArrowRight size */}
                          <div className="flex items-center justify-center">
                            <span className="text-base font-light text-muted-foreground/35 select-none leading-none">
                              +
                            </span>
                          </div>

                          {/* Reference Text */}
                          <div className="flex flex-col gap-1">
                            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 flex items-center gap-1">
                              <ScanText className="size-3" />
                              Reference Text
                            </span>
                            {hasRef ? (
                              <div className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-foreground/80 bg-blue-500/5 border border-blue-500/20 p-2.5 rounded-lg min-h-[80px] max-h-[180px] overflow-y-auto">
                                {page.referenceText}
                              </div>
                            ) : (
                              <div className="flex flex-col items-center justify-center min-h-[80px] bg-muted/10 rounded-lg border border-dashed text-muted-foreground/40 text-[11px] italic gap-1">
                                <ScanText className="size-4 opacity-30" />
                                <span>No text layer</span>
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Center arrow (horizontal on desktop, vertical on mobile) */}
                        <div className="hidden md:flex items-center justify-center px-3 self-center">
                          <ArrowRight className="size-4 text-muted-foreground/35" />
                        </div>
                        <div className="flex md:hidden items-center justify-center py-1 shrink-0">
                          <ArrowDown className="size-4 text-muted-foreground/35" />
                        </div>

                        {/* Right 2/3: Markdown */}
                        <div className="flex flex-col gap-1 w-full md:w-auto">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 flex items-center gap-1">
                            <FileText className="size-3" />
                            Markdown
                          </span>
                          {page.markdown ? (
                            <div
                              className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-foreground/90 bg-emerald-500/5 border border-emerald-500/20 p-2.5 rounded-lg flex-1 overflow-y-auto"
                              style={{ minHeight: "calc(100% - 20px)", maxHeight: "420px" }}
                            >
                              {page.markdown}
                            </div>
                          ) : (
                            <div
                              className="flex flex-col items-center justify-center bg-muted/10 rounded-lg border border-dashed text-muted-foreground/40 text-[11px] italic gap-1 flex-1"
                              style={{ minHeight: "200px" }}
                            >
                              <FileText className="size-4 opacity-30" />
                              <span>Pending…</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-muted-foreground text-xs italic text-center p-8 border border-dashed rounded-lg bg-muted/5 w-full">
                No page screenshots available for this document (e.g. legacy or non-PDF format).
              </p>
            )
          ) : activeTab === "chunks" ? (
            // Tab 3: Embed Chunks
            <div className="space-y-3 w-full">
              {detail.chunks.length === 0 ? (
                detail.doc.status === "pending" || detail.doc.status === "parsing" ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 px-1 text-[11px] text-muted-foreground italic">
                      <Loader2 className="size-3 animate-spin" aria-hidden />
                      Generating chunks… OCR finished, indexing in progress.
                    </div>
                    <Skeleton className="h-24 w-full" />
                    <Skeleton className="h-24 w-full" />
                    <Skeleton className="h-24 w-full" />
                  </div>
                ) : (
                  <p className="text-muted-foreground text-xs italic text-center p-8 border border-dashed rounded-lg bg-muted/5 w-full">
                    {detail.doc.status === "success"
                      ? "Embedding chunks are still being calculated in the background. They will appear here in a few moments."
                      : detail.doc.status === "failed"
                        ? "Ingestion failed — chunks not produced."
                        : "Ingestion in progress…"}
                  </p>
                )
              ) : (
                <>
                  {(() => {
                    const docInflight =
                      detail.doc.status === "pending" || detail.doc.status === "parsing";
                    const chunksInflight = detail.chunks.some(
                      (c) => c.status === "pending" || c.status === "parsing",
                    );
                    const showSpinner = docInflight || chunksInflight;
                    return (
                      <div className="flex items-center justify-between px-1 text-[11px]">
                        <span className="text-muted-foreground inline-flex items-center gap-1.5">
                          <span>Indexed</span>{" "}
                          <span className="text-foreground font-semibold tabular-nums">
                            {detail.chunks.filter((c) => c.status === "success").length}
                          </span>{" "}
                          <span>/ {detail.chunks.length}</span>
                          {showSpinner && (
                            <Loader2
                              className="text-muted-foreground size-3 animate-spin ml-1"
                              aria-label="chunks indexing in progress"
                            />
                          )}
                        </span>
                        {detail.chunks.some((c) => c.status === "failed") && (
                          <span className="text-destructive font-semibold tabular-nums">
                            {detail.chunks.filter((c) => c.status === "failed").length} failed
                          </span>
                        )}
                      </div>
                    );
                  })()}
                  {detail.chunks.map((c) => (
                    <div
                      key={c.ordinal}
                      className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm transition-all duration-200 hover:shadow-md"
                    >
                      {/* Card Header */}
                      <div className="flex items-center justify-between border-b px-4 py-2.5 bg-muted/40">
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] font-semibold capitalize tracking-wider text-muted-foreground">
                            Chunk #{c.ordinal + 1}
                          </span>
                          <ChunkStatusBadge status={c.status} errorMessage={c.errorMessage} />
                        </div>
                      </div>
                      {/* Card Body */}
                      <div className="p-4">
                        <p className="text-xs text-foreground/90 whitespace-pre-wrap break-all leading-relaxed">
                          {c.content}
                        </p>
                        {c.status === "failed" && c.errorMessage && (
                          <p
                            className="text-[10px] text-destructive/90 mt-2 italic"
                            title={c.errorMessage}
                          >
                            {c.errorMessage}
                          </p>
                        )}

                        {/* Metadata Box: Entities + Themes + Relationships */}
                        {((c.entities && c.entities.length > 0) ||
                          (c.themes && c.themes.length > 0) ||
                          (c.relationships && c.relationships.length > 0)) && (
                          <div className="mt-4 rounded-xl border border-muted-foreground/10 bg-slate-50/50 dark:bg-muted/10 p-3.5 space-y-3">
                            {/* Entities in chunk */}
                            {c.entities && c.entities.length > 0 && (
                              <div className="flex flex-col gap-1.5">
                                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 flex items-center gap-1 select-none">
                                  Entities
                                </span>
                                <div className="flex flex-wrap gap-1.5">
                                  {c.entities.map((e, idx) => {
                                    const badgeColor =
                                      e.type.toLowerCase() === "person"
                                        ? "bg-blue-500/10 hover:bg-blue-500/20 text-blue-500 border-blue-500/20"
                                        : e.type.toLowerCase() === "organization"
                                          ? "bg-amber-500/10 hover:bg-amber-500/20 text-amber-500 border-amber-500/20"
                                          : e.type.toLowerCase() === "concept"
                                            ? "bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-500 border-emerald-500/20"
                                            : "bg-muted text-muted-foreground border-border";
                                    return (
                                      <Badge
                                        key={idx}
                                        className={cn(
                                          "text-[9px] font-medium py-0.5 px-1.5 rounded border shadow-none",
                                          badgeColor,
                                        )}
                                        title={`${e.name} (${e.type}): ${e.description}`}
                                      >
                                        {e.name}
                                      </Badge>
                                    );
                                  })}
                                </div>
                              </div>
                            )}

                            {/* Separator if there are both entities and themes/relationships */}
                            {c.entities &&
                              c.entities.length > 0 &&
                              ((c.themes && c.themes.length > 0) ||
                                (c.relationships && c.relationships.length > 0)) && (
                                <Separator className="bg-muted-foreground/10" />
                              )}

                            {/* Themes in chunk */}
                            {c.themes && c.themes.length > 0 && (
                              <div className="flex flex-col gap-1.5">
                                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 flex items-center gap-1 select-none">
                                  Themes
                                </span>
                                <div className="flex flex-wrap gap-1.5">
                                  {c.themes.map((t, idx) => (
                                    <Badge
                                      key={idx}
                                      variant="secondary"
                                      className="bg-primary/5 hover:bg-primary/10 border-primary/20 text-primary text-[10px] font-medium py-0.5 px-2 rounded-md shadow-none"
                                    >
                                      #{t}
                                    </Badge>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Separator if there are relationships and themes */}
                            {c.themes &&
                              c.themes.length > 0 &&
                              c.relationships &&
                              c.relationships.length > 0 && (
                                <Separator className="bg-muted-foreground/10" />
                              )}

                            {/* Relationships in chunk */}
                            {c.relationships && c.relationships.length > 0 && (
                              <div className="flex flex-col gap-1.5">
                                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 flex items-center gap-1 select-none">
                                  Relationships
                                </span>
                                <div className="space-y-1.5">
                                  {c.relationships.map((r, idx) => (
                                    <div
                                      key={idx}
                                      className="text-[10px] text-muted-foreground leading-relaxed"
                                    >
                                      <span className="font-semibold text-foreground">
                                        {r.source}
                                      </span>
                                      <span className="italic mx-1 text-primary">
                                        ({r.relation})
                                      </span>
                                      <span className="font-semibold text-foreground">
                                        {r.target}
                                      </span>
                                      <span className="mx-1">•</span>
                                      <span className="text-foreground/85">{r.description}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          ) : (
            // Tab 4: LightRAG Knowledge Graph
            <div className="space-y-4 w-full min-h-[540px] flex flex-col min-w-0">
              {detail.chunks.length === 0 ? (
                <p className="text-muted-foreground text-xs italic text-center p-8 border border-dashed rounded-lg bg-muted/5 w-full">
                  No graph data available. Reprocess the document to extract entities and
                  relationships.
                </p>
              ) : (
                <>
                  <div className="flex items-center gap-1 border-b border-border text-xs w-full sm:w-fit pb-0 shrink-0 select-none ml-1">
                    <button
                      onClick={() => setGraphView("visual")}
                      className={cn(
                        "inline-flex items-center justify-center whitespace-nowrap text-[11px] font-semibold transition-all duration-200 pb-2.5 -mb-[1px] border-b-2 px-3 flex-1 sm:flex-initial",
                        graphView === "visual"
                          ? "border-foreground text-foreground font-semibold"
                          : "border-transparent text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Eye className="size-3.5 sm:mr-1.5 shrink-0" />
                      <span className="hidden sm:inline">Visual Map</span>
                    </button>
                    <button
                      onClick={() => setGraphView("themes")}
                      className={cn(
                        "inline-flex items-center justify-center whitespace-nowrap text-[11px] font-semibold transition-all duration-200 pb-2.5 -mb-[1px] border-b-2 px-3 flex-1 sm:flex-initial",
                        graphView === "themes"
                          ? "border-foreground text-foreground font-semibold"
                          : "border-transparent text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Hash className="size-3.5 sm:mr-1 shrink-0" />
                      <span className="hidden sm:inline">Themes ({uniqueThemes.length})</span>
                    </button>
                    <button
                      onClick={() => setGraphView("entities")}
                      className={cn(
                        "inline-flex items-center justify-center whitespace-nowrap text-[11px] font-semibold transition-all duration-200 pb-2.5 -mb-[1px] border-b-2 px-3 flex-1 sm:flex-initial",
                        graphView === "entities"
                          ? "border-foreground text-foreground font-semibold"
                          : "border-transparent text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Tags className="size-3.5 sm:mr-1.5 shrink-0" />
                      <span className="hidden sm:inline">Entities ({uniqueEntities.length})</span>
                    </button>
                    <button
                      onClick={() => setGraphView("relationships")}
                      className={cn(
                        "inline-flex items-center justify-center whitespace-nowrap text-[11px] font-semibold transition-all duration-200 pb-2.5 -mb-[1px] border-b-2 px-3 flex-1 sm:flex-initial",
                        graphView === "relationships"
                          ? "border-foreground text-foreground font-semibold"
                          : "border-transparent text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Link2 className="size-3.5 sm:mr-1.5 shrink-0" />
                      <span className="hidden sm:inline">
                        Relationships ({uniqueRelationships.length})
                      </span>
                    </button>
                  </div>

                  <div className="flex-1 min-h-0 min-w-0">
                    {graphView === "visual" && (
                      <div
                        ref={containerRef}
                        className="border rounded-xl bg-slate-50/50 overflow-hidden shadow-inner h-[500px] w-full flex items-center justify-center relative animate-fade-in"
                      >
                        {graphData.nodes.length === 0 ? (
                          <span className="text-muted-foreground text-xs italic">
                            No entities to visualize yet.
                          </span>
                        ) : (
                          <ForceGraph2D
                            graphData={graphData}
                            width={dimensions.width}
                            height={dimensions.height}
                            nodeRelSize={6}
                            nodeVal={(node: any) => node.degree || 1}
                            nodeLabel={(node: any) => `
                              <div style="
                                padding: 8px 10px;
                                background: white;
                                color: #1e293b;
                                border-radius: 8px;
                                border: 1px solid #e2e8f0;
                                box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
                                font-family: system-ui, -apple-system, sans-serif;
                                font-size: 11px;
                                max-width: 240px;
                                line-height: 1.4;
                              ">
                                <strong style="display: block; font-weight: 600; border-bottom: 1px solid #f1f5f9; padding-bottom: 4px; margin-bottom: 4px;">${node.name}</strong>
                                <span style="display: block; font-size: 9px; color: #64748b; font-weight: 500; margin-bottom: 3px; text-transform: uppercase; letter-spacing: 0.05em;">Type: ${node.type}</span>
                                <span style="display: block; color: #475569; font-weight: 400;">${node.description}</span>
                              </div>
                            `}
                            linkLabel={(link: any) => `
                              <div style="
                                padding: 8px 10px;
                                background: white;
                                color: #1e293b;
                                border-radius: 8px;
                                border: 1px solid #e2e8f0;
                                box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
                                font-family: system-ui, -apple-system, sans-serif;
                                font-size: 11px;
                                max-width: 240px;
                                line-height: 1.4;
                              ">
                                <strong style="display: block; font-weight: 600; margin-bottom: 3px; color: #0f172a;">${link.source.name || link.source} ──(${link.relation})──&gt; ${link.target.name || link.target}</strong>
                                <span style="display: block; color: #64748b; font-weight: 400;">${link.description}</span>
                              </div>
                            `}
                            linkDirectionalArrowLength={6}
                            linkDirectionalArrowRelPos={1}
                            linkWidth={1.5}
                            linkColor={() => "rgba(148, 163, 184, 0.45)"}
                            cooldownTicks={80}
                            nodeCanvasObject={(node: any, ctx, globalScale) => {
                              const label = node.name;
                              const degree = node.degree || 1;
                              const r = Math.min(10, 4.5 + degree * 0.4);

                              let color = "#e2e8f0";
                              let strokeColor = "#64748b";
                              const typeLower = node.type.toLowerCase();
                              if (typeLower === "person") {
                                color = "#eff6ff";
                                strokeColor = "#3b82f6";
                              } else if (typeLower === "organization") {
                                color = "#fffbeb";
                                strokeColor = "#f59e0b";
                              } else if (typeLower === "concept") {
                                color = "#ecfdf5";
                                strokeColor = "#10b981";
                              }

                              ctx.beginPath();
                              ctx.arc(node.x, node.y, r, 0, 2 * Math.PI, false);
                              ctx.fillStyle = color;
                              ctx.fill();
                              ctx.lineWidth = 1.5;
                              ctx.strokeStyle = strokeColor;
                              ctx.stroke();

                              if (globalScale > 0.8) {
                                const fontSize = Math.max(7.5, 9 / globalScale);
                                ctx.font = `500 ${fontSize}px Inter, system-ui, -apple-system, sans-serif`;
                                ctx.textAlign = "center";
                                ctx.textBaseline = "top";
                                ctx.fillStyle = "#334155";

                                let displayLabel = label;
                                if (label.length > 12) {
                                  displayLabel = label.substring(0, 10) + "...";
                                }
                                ctx.fillText(displayLabel, node.x, node.y + r + 3);
                              }
                            }}
                          />
                        )}
                      </div>
                    )}

                    {graphView === "themes" && uniqueThemes.length > 0 && (
                      <div className="space-y-2">
                        <div className="flex flex-wrap gap-1.5 p-1 max-h-[500px] overflow-y-auto">
                          {uniqueThemes.map((theme, i) => (
                            <Badge
                              key={i}
                              variant="secondary"
                              className="bg-primary/5 hover:bg-primary/10 border-primary/20 text-primary text-[11px] font-medium py-0.5 px-2 rounded-md"
                            >
                              #{theme}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}

                    {graphView === "entities" && uniqueEntities.length > 0 && (
                      <div className="border rounded-xl bg-card overflow-hidden shadow-sm">
                        <div className="max-h-[500px] overflow-y-auto divide-y">
                          <div className="sticky top-0 z-10 hidden sm:grid sm:grid-cols-[1.5fr_1.2fr_3fr] gap-4 px-4 py-2 border-b bg-muted/95 backdrop-blur-sm text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                            <div>Name</div>
                            <div className="truncate">Type</div>
                            <div>Description</div>
                          </div>
                          {uniqueEntities.map((e, idx) => {
                            const badgeColor =
                              e.type.toLowerCase() === "person"
                                ? "bg-blue-500/10 hover:bg-blue-500/20 text-blue-500 border-blue-500/20"
                                : e.type.toLowerCase() === "organization"
                                  ? "bg-amber-500/10 hover:bg-amber-500/20 text-amber-500 border-amber-500/20"
                                  : e.type.toLowerCase() === "concept"
                                    ? "bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-500 border-emerald-500/20"
                                    : "bg-muted text-muted-foreground border-border";
                            return (
                              <div
                                key={idx}
                                className="flex flex-col gap-2 p-4 sm:grid sm:grid-cols-[1.5fr_1.2fr_3fr] sm:gap-4 sm:px-4 sm:py-2 text-xs leading-relaxed items-start bg-card w-full min-w-0"
                              >
                                <span className="font-semibold text-foreground break-all">
                                  {e.name}
                                </span>
                                <div className="min-w-0 flex items-center gap-1.5 sm:gap-0">
                                  <span className="sm:hidden text-[9px] text-muted-foreground font-semibold uppercase tracking-wider select-none shrink-0">
                                    Type:
                                  </span>
                                  <Badge
                                    className={cn(
                                      "text-[10px] font-medium py-0 px-1.5 rounded border shadow-none truncate max-w-full block",
                                      badgeColor,
                                    )}
                                    title={e.type}
                                  >
                                    {e.type}
                                  </Badge>
                                </div>
                                <div className="text-muted-foreground break-all flex flex-col gap-0.5 sm:block w-full min-w-0">
                                  <span className="sm:hidden text-[9px] text-muted-foreground font-semibold uppercase tracking-wider select-none">
                                    Description:
                                  </span>
                                  <span>{e.description}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {graphView === "relationships" && uniqueRelationships.length > 0 && (
                      <div className="border rounded-xl bg-card overflow-hidden shadow-sm">
                        <div className="max-h-[500px] overflow-y-auto divide-y">
                          <div className="sticky top-0 z-10 hidden sm:grid sm:grid-cols-[1.5fr_1.2fr_3fr] gap-4 px-4 py-2 border-b bg-muted/95 backdrop-blur-sm text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                            <div>Connection</div>
                            <div>Relationship</div>
                            <div>Context / Description</div>
                          </div>
                          {uniqueRelationships.map((r, idx) => (
                            <div
                              key={idx}
                              className="flex flex-col gap-2 p-4 sm:grid sm:grid-cols-[1.5fr_1.2fr_3fr] sm:gap-x-3 sm:px-4 sm:py-2.5 text-xs leading-relaxed items-start bg-card w-full min-w-0"
                            >
                              <div className="flex flex-col gap-1 min-w-0 w-full">
                                <span className="sm:hidden text-[9px] text-muted-foreground font-semibold uppercase tracking-wider select-none">
                                  Connection:
                                </span>
                                <span className="font-semibold text-foreground break-all">
                                  {r.source}
                                </span>
                                <span className="text-[10px] text-muted-foreground flex items-center gap-1 min-w-0">
                                  <ArrowRight className="size-3 text-muted-foreground/60 shrink-0" />
                                  <span className="truncate">{r.target}</span>
                                </span>
                              </div>
                              <div className="min-w-0 flex items-center gap-1.5 sm:block">
                                <span className="sm:hidden text-[9px] text-muted-foreground font-semibold uppercase tracking-wider select-none shrink-0">
                                  Relationship:
                                </span>
                                <span className="italic text-primary/80 font-medium break-all mt-0.5 min-w-0">
                                  {r.relation}
                                </span>
                              </div>
                              <div className="text-muted-foreground break-all flex flex-col gap-0.5 sm:block w-full min-w-0">
                                <span className="sm:hidden text-[9px] text-muted-foreground font-semibold uppercase tracking-wider select-none">
                                  Context / Description:
                                </span>
                                <span>{r.description}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
