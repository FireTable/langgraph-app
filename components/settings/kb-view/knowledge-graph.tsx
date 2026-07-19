"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ArrowRight, Eye, Hash, Link2, Tags } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { entityColor, type EntityColor } from "@/lib/kb/entityColor";

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

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    setTooltipPos({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHoveredNode(null);
    setHoveredLink(null);
  }, []);

  // ponytail: stable callbacks for ForceGraph2D so the lib doesn't see
  // a new function identity every poll and re-stage its render loop.
  // nodeVal / nodeLabel / linkLabel are stateless — empty fns are fine.
  const nodeVal = useCallback((node: any) => {
    const degree = node.degree || 1;
    const r = Math.min(12, Math.max(2.5, 4.5 + degree * 0.4));
    return Math.pow(r / 6, 2);
  }, []);
  const emptyLabel = useCallback(() => "", []);
  const linkWidth = useCallback((link: any) => {
    const degree = Math.max(link.source?.degree ?? 1, link.target?.degree ?? 1);
    return Math.min(1.8, 0.8 + Math.log2(1 + degree) * 0.3);
  }, []);
  const linkColor = useCallback((link: any) => {
    const degree = Math.max(link.source?.degree ?? 1, link.target?.degree ?? 1);
    const alpha = Math.min(0.7, 0.28 + Math.log2(1 + degree) * 0.16);
    return `rgba(100, 116, 139, ${alpha.toFixed(3)})`;
  }, []);
  const onNodeHover = useCallback((node: any) => {
    setHoveredNode(node || null);
    if (node) setHoveredLink(null);
  }, []);
  const onLinkHover = useCallback((link: any) => {
    setHoveredLink(link || null);
    if (link) setHoveredNode(null);
  }, []);

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

  // ponytail: graphRAG-native node color map. Built once per graphData
  // shape. Each entry: name → {h,s,l,bg,fg,border}. Consumers:
  // nodeCanvasObject (canvas fill), hover tooltip badge, uniqueEntities
  // list badge, doc-detail-dialog entity badge. All read from this
  // single source. Neighbor signature drives hue (catches "two
  // entities in the same neighborhood"); degree drives saturation +
  // lightness (catches hubs vs leaves). Replaces the person /
  // organization / concept string whitelist that left ~40 LLM-extracted
  // types grey.
  // ponytail: doc-detail-dialog polls /api/kb/documents/[id] every 2s.
  // Each poll lands a fresh `chunks` array reference, which would force a
  // re-dedup + new graphData object, which would re-trigger
  // react-force-graph-2d's D3 simulation from scratch (visual flicker +
  // layout thrash). We pin the dedup OUTPUT to a fingerprint: if the
  // rolled-up (entity name + description) and (rel triple + description)
  // bag is identical across polls, we keep the previous graphData
  // reference. The fingerprint is a sorted, name-folded string concat —
  // cheap (≤ a few KB for thousands of entities) and stable across polls
  // when content hasn't changed (e.g. one chunk flips parsing → success).
  const dedupFingerprint = useMemo(() => {
    const parts: string[] = [];
    for (const c of chunks ?? []) {
      if (skipFailedChunks && c.status !== "success") continue;
      for (const e of c.entities ?? []) {
        parts.push(`E|${e.name.toLowerCase()}|${e.type}|${e.description}`);
      }
      for (const r of c.relationships ?? []) {
        parts.push(
          `R|${r.source.toLowerCase()}|${r.target.toLowerCase()}|${r.relation.toLowerCase()}|${r.description}`,
        );
      }
      for (const t of c.themes ?? []) {
        parts.push(`T|${t}`);
      }
    }
    parts.sort();
    return parts.join("\n");
  }, [chunks, skipFailedChunks]);

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
    // ponytail: depend on the fingerprint (stable across same-content polls),
    // not the raw `chunks` array (which flips reference every 2s poll).
  }, [dedupFingerprint, chunks?.length, skipFailedChunks]);

  // ponytail: graphRAG-native node color map. Built once per graphData
  // shape (graphData refs are pinned by the dedup fingerprint above so
  // polls with unchanged content don't churn this). Each entry:
  // name → {h,s,l,bg,fg,border}. Consumers: nodeCanvasObject (canvas
  // fill), hover tooltip badge, uniqueEntities list badge, and
  // doc-detail-dialog entity badge (all import entityColor from
  // lib/kb/entityColor — single source of truth).
  // ponytail: same neighbor signature = same hue (catches "two
  // entities in the same neighborhood"); degree drives saturation +
  // lightness (catches hubs vs leaves). Replaces the person /
  // organization / concept string whitelist that left ~40 LLM-
  // extracted types grey.
  const nodeColors = useMemo(() => {
    const degreeByName = new Map<string, number>();
    const neighborsByName = new Map<string, Set<string>>();
    for (const link of graphData.links) {
      const s = link.source as unknown as { name?: string; id?: string };
      const t = link.target as unknown as { name?: string; id?: string };
      const src = (s?.name ?? s?.id ?? String(link.source)) as string;
      const tgt = (t?.name ?? t?.id ?? String(link.target)) as string;
      degreeByName.set(src, (degreeByName.get(src) ?? 0) + 1);
      degreeByName.set(tgt, (degreeByName.get(tgt) ?? 0) + 1);
      if (!neighborsByName.has(src)) neighborsByName.set(src, new Set());
      if (!neighborsByName.has(tgt)) neighborsByName.set(tgt, new Set());
      neighborsByName.get(src)!.add(tgt);
      neighborsByName.get(tgt)!.add(src);
    }
    const out = new Map<string, EntityColor>();
    for (const n of graphData.nodes) {
      const name = (n as { name?: string; id?: string }).name ?? (n as { id: string }).id;
      const degree = degreeByName.get(name) ?? (n as { degree?: number }).degree ?? 0;
      out.set(name, entityColor(name, [...(neighborsByName.get(name) ?? [])], degree));
    }
    return out;
  }, [graphData.nodes, graphData.links]);

  // ponytail: lookup helper with muted-slate fallback for any entity
  // name not in the color map (e.g. a row that survived dedup
  // filtering but lost its neighbors).
  const colorFor = useCallback(
    (name: string): EntityColor => nodeColors.get(name) ?? entityColor(name, [], 0),
    [nodeColors],
  );

  // ponytail: canvas node paint. Reads bg/fg/border from the
  // graphRAG-native color map instead of the person/organization/
  // concept whitelist (which left 39/40 of this doc's entity types
  // grey). Pulled after nodeColors so the closure can read it.
  const nodeCanvasObject = useCallback(
    (node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
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
      // ponytail: smaller radius range after the redesign. degree
      // 1-2 sits at 2.5 (tiny), 8+ at 8 (visible hub). Avoids the
      // "1.5x the size of everything else" effect we saw in the first
      // visual pass.
      const r = Math.min(8, Math.max(2.5, 2.5 + degree * 0.6 + zoomBoost));

      // ponytail: flat fill + 1px stroke. Replaces the radial gradient
      // (which gave every node a 3D ball look) — now matches the
      // outline style of the badges: light bg fill, same-hue border.
      // Hue from entityColor (neighbor signature); saturation pulled
      // down so dots don't compete with each other on the slate bg.
      let fillColor = "#f1f5f9";
      let strokeColor = "#475569";
      const nodeColor = nodeColors.get(label);
      if (nodeColor) {
        fillColor = nodeColor.bg;
        strokeColor = nodeColor.border;
      }

      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI, false);
      ctx.fillStyle = fillColor;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = strokeColor;
      ctx.stroke();

      // ponytail: label visibility tightened — only hubs (degree >= 6)
      // and nodes the user explicitly zoomed into (globalScale > 1.6)
      // get a label. The old "globalScale > 0.6 + degree 3" rule
      // flooded the canvas with overlapping text on the 321-entity
      // folder view.
      const showLabel = degree >= 6 || globalScale > 1.6;
      if (showLabel) {
        const fontSize = Math.max(2.6, 3.4 - Math.min(0.8, degree * 0.06));
        ctx.font = `${fontSize}px Inter, system-ui, -apple-system, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";

        const maxLen = globalScale > 1.5 ? 18 : globalScale > 0.9 ? 12 : 8;
        let displayLabel = label;
        if (label.length > maxLen) {
          displayLabel = label.substring(0, maxLen - 2) + "...";
        }

        // ponytail: no white stroke halo around the label anymore.
        // The plain muted text on the slate-50 bg reads cleanly
        // without it, and the stroke was making labels visually
        // heavier than the nodes themselves.
        ctx.fillStyle = "#475569";
        ctx.fillText(displayLabel, node.x, node.y + r + 3.5);
      }
    },
    [nodeColors],
  );

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
            onMouseLeave={handleMouseLeave}
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
                  nodeVal={nodeVal}
                  nodeLabel={emptyLabel}
                  linkLabel={emptyLabel}
                  linkDirectionalArrowLength={6}
                  linkDirectionalArrowRelPos={1}
                  linkWidth={linkWidth}
                  linkColor={linkColor}
                  cooldownTicks={80}
                  nodeCanvasObject={nodeCanvasObject}
                  onNodeHover={onNodeHover}
                  onLinkHover={onLinkHover}
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
                    // ponytail: hover tooltip type badge — color from
                    // graphRAG-native entityColor (hue = neighbor
                    // signature, sat/light = degree). Replaces the
                    // person/organization/concept/team/job/motto
                    // string whitelist.
                    const hoveredColor = colorFor(hoveredNode.name);

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
                              )}
                              style={{
                                backgroundColor: hoveredColor.bg,
                                color: hoveredColor.fg,
                                borderColor: hoveredColor.border,
                              }}
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
                // ponytail: list-view type badge — color from
                // graphRAG-native entityColor (same source as canvas
                // nodes + hover tooltip + doc-detail-dialog). No
                // string-type whitelist; hue = neighbor signature,
                // saturation/lightness = degree.
                const listColor = colorFor(e.name);
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
                        className="text-[10px] font-medium py-0 px-1.5 rounded border shadow-none truncate max-w-full block"
                        style={{
                          backgroundColor: listColor.bg,
                          color: listColor.fg,
                          borderColor: listColor.border,
                        }}
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
