"use client";

import { useState } from "react";
import { FileTextIcon } from "lucide-react";

import { chunkPreview, legBadges } from "./parser";
import type { KbDocument } from "./types";

// ponytail: shared chunk list — search_kb and search_graph both render
// the same { [n] · title · leg badges · preview } rows. Order is locked
// to the backend's RRF ranking (.claude/13-kb-v3.md "顺序锁定").
// Now collapsible (default 3) to prevent large context lists from
// cluttering the chat view.

export function KbChunkList({ docs, slot }: { docs: KbDocument[]; slot: string }) {
  const [expanded, setExpanded] = useState(false);

  if (docs.length === 0) return null;

  const isRerank = docs.some((d) => d.rrfScore > 0.05);
  const visibleDocs = expanded ? docs : docs.slice(0, 3);
  const hasMore = docs.length > 3;

  return (
    <div className="flex flex-col gap-2 w-full">
      <ol className="flex flex-col gap-2">
        {visibleDocs.map((doc, i) => {
          const badges = legBadges(doc.legsHit);
          return (
            <li
              key={doc.chunkId}
              data-slot={slot}
              className="border-border/60 bg-muted/30 flex flex-col gap-1.5 rounded-lg border p-3 transition-colors hover:bg-muted/50"
            >
              <div className="flex items-center gap-2 text-xs">
                <span className="bg-primary/10 text-primary rounded px-1.5 py-0.5 font-mono font-medium tabular-nums">
                  [{i + 1}]
                </span>
                <FileTextIcon className="text-muted-foreground size-3.5 shrink-0" />
                <span className="text-foreground truncate font-semibold max-w-[200px] sm:max-w-[400px]">
                  {doc.docTitle}
                </span>
                <div className="ms-auto flex items-center gap-1.5 shrink-0">
                  {typeof doc.rrfScore === "number" && doc.rrfScore > 0 && (
                    <span className="text-muted-foreground bg-background/50 rounded border border-border/60 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide shrink-0">
                      Score:{" "}
                      {isRerank ? `${Math.round(doc.rrfScore * 100)}%` : doc.rrfScore.toFixed(3)}
                    </span>
                  )}
                  {badges.length > 0 && (
                    <div className="flex gap-1">
                      {badges.map((b) => (
                        <span
                          key={b}
                          className="text-muted-foreground bg-background/50 rounded border border-border/60 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide shrink-0"
                        >
                          {b}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <p className="text-muted-foreground text-xs leading-relaxed break-words whitespace-pre-wrap">
                {chunkPreview(doc.content)}
              </p>
            </li>
          );
        })}
      </ol>
      {hasMore && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-primary hover:text-primary/80 self-center text-xs font-medium transition-colors py-1 px-3 mt-1"
        >
          {expanded ? "Show less" : `Show more (+${docs.length - 3} chunks)`}
        </button>
      )}
    </div>
  );
}
