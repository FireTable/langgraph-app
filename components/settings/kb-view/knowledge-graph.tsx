"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ArrowRight, Eye, Hash, Link2, Tags } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// ponytail: shared KnowledgeGraph card used by both the per-document
// preview dialog (doc-detail-dialog) and the per-folder graph dialog
// (folder-graph-dialog). Caller hands us a chunk list and decides
// whether non-success chunks should be folded into the dedup pass
// (folder-graph view skips them; per-doc view historically kept
// them — same wire shape either way so the children can render
// anything the dedup drops).

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground italic">
      Loading visual map...
    </div>
  ),
});

type KgEntity = { name: string; type: string; description: string };
type KgRelationship = {
  source: string;
  target: string;
  relation: string;
  description: string;
};

export type KnowledgeGraphChunk = {
  entities: KgEntity[];
  relationships: KgRelationship[];
  themes: string[];
  status: "pending" | "parsing" | "success" | "failed";
};

export type KnowledgeGraphProps = {
  chunks: KnowledgeGraphChunk[];
  /**
   * ponytail: dedup entities by `name::type` (case-folded) so two
   * chunks tagging "Acme" with different Types both surface on the
   * graph. Relationship key is `source::target::relation`. Themes
   * dedup by exact string. Only chunks with status='success' land
   * in the rollup when this is on.
   */
  skipFailedChunks?: boolean;
  /**
   * Copy shown when chunks.length === 0. Defaults to "Upload a
   * document into this folder to extract entities and relationships."
   */
  emptyMessage?: string;
};

export function KnowledgeGraph({
  chunks,
  skipFailedChunks = false,
  emptyMessage = "Upload a document into this folder to extract entities and relationships.",
}: KnowledgeGraphProps) {
  const [graphView, setGraphView] = useState<"visual" | "themes" | "entities" | "relationships">(
    "visual",
  );

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dimensions, setDimensions] = useState({ width: 600, height: 500 });
  const [hoveredNode, setHoveredNode] = useState<any>(null);
  const [hoveredLink, setHoveredLink] = useState<any>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    setTooltipPos({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  };

  // ponytail: react-force-graph-2d instance ref so we can call
  // zoomToFit() once after first layout, animating into the cluster
  // instead of forcing the user to scroll-zoom in. We re-fit whenever
  // graph data shape materially changes (entity / relationship count
  // jumps by > 5) so a re-render lands on a useful framing.
  const graphRef = useRef<any>(null);
  const lastFittedKey = useRef<string>("");

  useEffect(() => {
    if (graphView !== "visual" || !containerRef.current) return;
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width } = entry.contentRect;
        setDimensions({ width: width || 600, height: 500 });
      }
    });
    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, [graphView]);

  const { uniqueThemes, uniqueEntities, uniqueRelationships, graphData } = useMemo(() => {
    if (!chunks || chunks.length === 0) {
      return {
        uniqueThemes: [],
        uniqueEntities: [],
        uniqueRelationships: [],
        graphData: { nodes: [], links: [] },
      };
    }

    const themesSet = new Set<string>();
    // ponytail: entity dedup is name-only (case-folded). Whether LLM
    // tagged "Acme" as `Organization` or `Tool`, we collapse to one
    // node — keeps the graph dense for per-doc preview where 17
    // chunks mentioning the same person shouldn't render as 17 islands.
    // Longest description wins for that bucket.
    const entityMap = new Map<string, KgEntity>();
    const relMap = new Map<string, KgRelationship>();

    for (const c of chunks) {
      if (skipFailedChunks && c.status !== "success") continue;
      for (const t of c.themes ?? []) {
        themesSet.add(t);
      }
      for (const e of c.entities ?? []) {
        const key = e.name.toLowerCase();
        const existing = entityMap.get(key);
        if (!existing || e.description.length > existing.description.length) {
          entityMap.set(key, e);
        }
      }
      for (const r of c.relationships ?? []) {
        // ponytail: relationships fold on (source, target, relation).
        // Direction matters — A->B and B->A stay separate rows.
        const key = `${r.source.toLowerCase()}::${r.target.toLowerCase()}::${r.relation.toLowerCase()}`;
        const existing = relMap.get(key);
        if (!existing || r.description.length > existing.description.length) {
          relMap.set(key, r);
        }
      }
    }

    const uniqueThemes = Array.from(themesSet).sort();
    const uniqueEntities = Array.from(entityMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    const uniqueRelationships = Array.from(relMap.values()).sort((a, b) =>
      a.source.localeCompare(b.source),
    );

    // ponytail: degree for each entity — incoming or outgoing edge
    // count under case-folded names so a rel like "Acme uses Beta"
    // contributes to `Acme.degree` and `Beta.degree` symmetrically.
    const degrees = new Map<string, number>();
    for (const r of uniqueRelationships) {
      const src = r.source.toLowerCase();
      const tgt = r.target.toLowerCase();
      degrees.set(src, (degrees.get(src) || 0) + 1);
      degrees.set(tgt, (degrees.get(tgt) || 0) + 1);
    }

    const nodes = uniqueEntities.map((e) => ({
      id: e.name.toLowerCase(),
      name: e.name,
      type: e.type,
      description: e.description,
      degree: degrees.get(e.name.toLowerCase()) || 0,
    }));

    const links = uniqueRelationships.map((r) => ({
      source: r.source.toLowerCase(),
      target: r.target.toLowerCase(),
      relation: r.relation,
      description: r.description,
    }));

    // Filter out links pointing to non-existent nodes to prevent D3-force from crashing
    const validNodeIds = new Set(nodes.map((n) => n.id));
    const filteredLinks = links.filter(
      (l) => validNodeIds.has(l.source) && validNodeIds.has(l.target),
    );

    return {
      uniqueThemes,
      uniqueEntities,
      uniqueRelationships,
      graphData: { nodes, links: filteredLinks },
    };
  }, [chunks, skipFailedChunks]);

  // ponytail: re-fit whenever the node/edge count materially changes
  // so the graph lands on a useful framing for the user. Defers a
  // tick so the simulation has its first coords before we ask for a
  // fit. Idempotent across renders — lastFittedKey dedupes.
  useEffect(() => {
    if (graphView !== "visual") return;
    const key = `${graphData.nodes.length}-${graphData.links.length}`;
    if (key === lastFittedKey.current) return;
    lastFittedKey.current = key;
    const raf = requestAnimationFrame(() => graphRef.current?.zoomToFit(400, 60));
    const id = setTimeout(() => graphRef.current?.zoomToFit(400, 60), 300);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(id);
    };
  }, [graphData.nodes.length, graphData.links.length, graphView]);

  if (chunks.length === 0) {
    return (
      <p className="text-muted-foreground text-xs italic text-center p-8 border border-dashed rounded-lg bg-muted/5 w-full">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className="space-y-4 w-full min-h-[540px] flex flex-col min-w-0">
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
            "inline-flex items-center justify-center whitespace-nowrap text-[11px] font-semibold transition-all duration-200 pb-2.5 -mb-[1px] border-b-2 px-3 sm:flex-initial",
            graphView === "relationships"
              ? "border-foreground text-foreground font-semibold"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          <Link2 className="size-3.5 sm:mr-1.5 shrink-0" />
          <span className="hidden sm:inline">Relationships ({uniqueRelationships.length})</span>
        </button>
      </div>

      <div className="flex-1 min-h-0 min-w-0">
        {graphView === "visual" && (
          <div
            ref={containerRef}
            onMouseMove={handleMouseMove}
            onMouseLeave={() => {
              setHoveredNode(null);
              setHoveredLink(null);
            }}
            className="border rounded-xl bg-slate-50/50 overflow-hidden shadow-inner h-[500px] w-full flex items-center justify-center relative animate-fade-in"
          >
            {graphData.nodes.length === 0 ? (
              <span className="text-muted-foreground text-xs italic">
                No entities to visualize yet.
              </span>
            ) : (
              <>
                <ForceGraph2D
                  ref={graphRef}
                  graphData={graphData}
                  width={dimensions.width}
                  height={dimensions.height}
                  nodeRelSize={6}
                  nodeVal={(node: any) => {
                    const degree = node.degree || 1;
                    const r = Math.min(12, Math.max(2.5, 4.5 + degree * 0.4));
                    return Math.pow(r / 6, 2);
                  }}
                  nodeLabel={() => ""}
                  linkLabel={() => ""}
                  linkDirectionalArrowLength={6}
                  linkDirectionalArrowRelPos={1}
                  linkWidth={(link: any) => {
                    const degree = Math.max(link.source?.degree ?? 1, link.target?.degree ?? 1);
                    return Math.min(1.8, 0.8 + Math.log2(1 + degree) * 0.3);
                  }}
                  linkColor={(link: any) => {
                    const degree = Math.max(link.source?.degree ?? 1, link.target?.degree ?? 1);
                    const alpha = Math.min(0.7, 0.28 + Math.log2(1 + degree) * 0.16);
                    return `rgba(100, 116, 139, ${alpha.toFixed(3)})`;
                  }}
                  cooldownTicks={80}
                  nodeCanvasObject={(node: any, ctx, globalScale) => {
                    if (
                      typeof node.x !== "number" ||
                      typeof node.y !== "number" ||
                      !isFinite(node.x) ||
                      !isFinite(node.y)
                    ) {
                      return;
                    }

                    const label = node.name;
                    const degree = node.degree || 1;
                    const zoomBoost = Math.min(0.6, Math.max(-0.5, (globalScale - 1) * -0.55));
                    const r = Math.min(12, Math.max(2.5, 4.5 + degree * 0.4 + zoomBoost));

                    // Glowing 3D radial gradient coloring
                    let colorStart = "#f8fafc";
                    let colorEnd = "#cbd5e1";
                    let strokeColor = "#475569";
                    const typeLower = node.type?.toLowerCase();
                    if (typeLower === "person") {
                      colorStart = "#dbeafe";
                      colorEnd = "#3b82f6";
                      strokeColor = "#1d4ed8";
                    } else if (typeLower === "organization") {
                      colorStart = "#fef3c7";
                      colorEnd = "#f59e0b";
                      strokeColor = "#d97706";
                    } else if (typeLower === "concept") {
                      colorStart = "#d1fae5";
                      colorEnd = "#10b981";
                      strokeColor = "#059669";
                    }

                    const gradient = ctx.createRadialGradient(
                      node.x - r * 0.15,
                      node.y - r * 0.15,
                      r * 0.1,
                      node.x,
                      node.y,
                      r,
                    );
                    gradient.addColorStop(0, colorStart);
                    gradient.addColorStop(0.85, colorEnd);
                    gradient.addColorStop(1, strokeColor);

                    ctx.beginPath();
                    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI, false);
                    ctx.fillStyle = gradient;
                    ctx.fill();
                    ctx.lineWidth = 1.0;
                    ctx.strokeStyle = strokeColor;
                    ctx.stroke();

                    // ponytail: tiered label density & canvas scale
                    // Zoom-out (cluster view) only draws labels for key hub nodes to prevent overlapping.
                    // As the user zooms in, we draw more minor leaf labels.
                    const showLabel =
                      globalScale > 1.2 || (globalScale > 0.6 && degree >= 3) || degree >= 6;
                    if (showLabel) {
                      // Font size is fixed in canvas coordinates so it shrinks/scales with zoom.
                      const fontSize = Math.max(2.8, 3.8 - Math.min(1.0, degree * 0.08));
                      const isHub = degree >= 4;
                      ctx.font = `${isHub ? 600 : 500} ${fontSize}px Inter, system-ui, -apple-system, sans-serif`;
                      ctx.textAlign = "center";
                      ctx.textBaseline = "top";

                      // Truncation based on zoom and degree
                      const maxLen = globalScale > 1.5 ? 18 : globalScale > 0.9 ? 12 : 8;
                      let displayLabel = label;
                      if (label.length > maxLen) {
                        displayLabel = label.substring(0, maxLen - 2) + "...";
                      }

                      // Stroke text for white halo background (improves legibility over links)
                      ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
                      ctx.lineWidth = 1.2;
                      ctx.lineJoin = "round";
                      ctx.strokeText(displayLabel, node.x, node.y + r + 3.5);

                      // Fill text
                      ctx.fillStyle = isHub ? "#0f172a" : "#475569";
                      ctx.fillText(displayLabel, node.x, node.y + r + 3.5);
                    }
                  }}
                  onNodeHover={(node) => {
                    setHoveredNode(node || null);
                    if (node) setHoveredLink(null);
                  }}
                  onLinkHover={(link) => {
                    setHoveredLink(link || null);
                    if (link) setHoveredNode(null);
                  }}
                />

                {(() => {
                  const isNode = !!hoveredNode;
                  const w = isNode ? 240 : 260;
                  const h = isNode ? 120 : 100; // estimated height offset

                  const rawX =
                    tooltipPos.x + w > dimensions.width ? tooltipPos.x - w - 6 : tooltipPos.x + 6;
                  const rawY =
                    tooltipPos.y + h > dimensions.height ? tooltipPos.y - h - 6 : tooltipPos.y + 6;
                  const left = Math.max(8, rawX);
                  const top = Math.max(8, rawY);

                  if (hoveredNode) {
                    const typeLower = hoveredNode.type?.toLowerCase() || "";
                    let badgeColor =
                      "bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20";
                    if (typeLower === "person") {
                      badgeColor =
                        "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/25";
                    } else if (typeLower === "organization" || typeLower === "company") {
                      badgeColor =
                        "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25";
                    } else if (
                      typeLower === "concept" ||
                      typeLower === "tech stack" ||
                      typeLower === "tool" ||
                      typeLower === "technology"
                    ) {
                      badgeColor =
                        "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/25";
                    } else if (typeLower === "team" || typeLower === "group") {
                      badgeColor =
                        "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/25";
                    } else if (typeLower === "job role" || typeLower === "position") {
                      badgeColor = "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/25";
                    } else if (typeLower === "motto" || typeLower === "contact information") {
                      badgeColor =
                        "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/25";
                    }

                    return (
                      <div
                        className="absolute z-50 pointer-events-none rounded-xl border border-border bg-background p-3.5 shadow-md w-[240px] text-xs leading-relaxed animate-in fade-in zoom-in-95 duration-100 select-none space-y-3 transition-all"
                        style={{
                          left: `${left}px`,
                          top: `${top}px`,
                        }}
                      >
                        <div>
                          <div className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground/60 mb-1.5 select-none">
                            Entity Info
                          </div>
                          <div className="flex items-center justify-between gap-2.5 bg-slate-50/50 dark:bg-slate-900/30 border border-border/40 p-2 rounded-lg select-none">
                            <span className="font-semibold text-foreground/90 truncate max-w-[120px]">
                              {hoveredNode.name}
                            </span>
                            <Badge
                              className={cn(
                                "text-[9px] font-semibold tracking-wider uppercase px-2 py-0.5 rounded-md shadow-none border shrink-0",
                                badgeColor,
                              )}
                            >
                              {hoveredNode.type || "Other"}
                            </Badge>
                          </div>
                        </div>

                        {hoveredNode.description && (
                          <div className="space-y-1 pt-2 border-t border-border/40">
                            <span className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground/60 block select-none">
                              Description
                            </span>
                            <p className="text-muted-foreground/95 leading-relaxed text-[11px] select-none break-words">
                              {hoveredNode.description}
                            </p>
                          </div>
                        )}
                      </div>
                    );
                  }

                  if (hoveredLink) {
                    return (
                      <div
                        className="absolute z-50 pointer-events-none rounded-xl border border-border bg-background p-3.5 shadow-md w-[260px] text-xs leading-relaxed animate-in fade-in zoom-in-95 duration-100 select-none space-y-3 transition-all"
                        style={{
                          left: `${left}px`,
                          top: `${top}px`,
                        }}
                      >
                        <div>
                          <div className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground/60 mb-1.5 select-none">
                            Relationship Path
                          </div>
                          <div className="flex items-center justify-between gap-1.5 bg-slate-50/50 dark:bg-slate-900/30 border border-border/40 p-2 rounded-lg select-none">
                            <span className="font-semibold text-foreground/90 truncate max-w-[90px]">
                              {hoveredLink.source.name || hoveredLink.source}
                            </span>
                            <span className="text-muted-foreground/40 font-normal">&rarr;</span>
                            <span className="font-semibold text-foreground/90 truncate max-w-[90px]">
                              {hoveredLink.target.name || hoveredLink.target}
                            </span>
                          </div>
                        </div>

                        <div className="space-y-1">
                          <div className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground/60 select-none">
                            Relation Type
                          </div>
                          <div>
                            <Badge className="text-[9px] font-semibold px-2 py-0.5 rounded-md bg-blue-500/10 text-blue-600 border border-blue-500/20 shadow-none uppercase tracking-wide shrink-0 select-none">
                              {hoveredLink.relation}
                            </Badge>
                          </div>
                        </div>

                        {hoveredLink.description && (
                          <div className="space-y-1 pt-2 border-t border-border/40">
                            <span className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground/60 block select-none">
                              Description
                            </span>
                            <p className="text-muted-foreground/95 leading-relaxed text-[11px] select-none break-words">
                              {hoveredLink.description}
                            </p>
                          </div>
                        )}
                      </div>
                    );
                  }

                  return null;
                })()}
              </>
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
                    <span className="font-semibold text-foreground break-all">{e.name}</span>
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
                    <span className="font-semibold text-foreground break-all">{r.source}</span>
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
    </div>
  );
}
