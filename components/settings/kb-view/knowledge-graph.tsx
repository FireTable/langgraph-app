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
      degrees.set(r.source, (degrees.get(r.source) || 0) + 1);
      degrees.set(r.target, (degrees.get(r.target) || 0) + 1);
    }

    const nodes = uniqueEntities.map((e) => ({
      id: e.name,
      name: e.name,
      type: e.type,
      description: e.description,
      degree: degrees.get(e.name) || 0,
    }));

    const links = uniqueRelationships.map((r) => ({
      source: r.source,
      target: r.target,
      relation: r.relation,
      description: r.description,
    }));

    return {
      uniqueThemes,
      uniqueEntities,
      uniqueRelationships,
      graphData: { nodes, links },
    };
  }, [chunks, skipFailedChunks]);

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
