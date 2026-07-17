import { FileTextIcon } from "lucide-react";

import { chunkPreview, legBadges } from "./parser";
import type { KbDocument } from "./types";

// ponytail: shared chunk list — search_kb and search_graph both render
// the same { [n] · title · leg badges · preview } rows. Order is locked
// to the backend's RRF ranking (.claude/13-kb-v3.md "顺序锁定").

export function KbChunkList({ docs, slot }: { docs: KbDocument[]; slot: string }) {
  return (
    <ol className="flex flex-col gap-2">
      {docs.map((doc, i) => {
        const badges = legBadges(doc.legsHit);
        return (
          <li
            key={doc.chunkId}
            data-slot={slot}
            className="border-border/60 bg-muted/30 flex flex-col gap-1.5 rounded-lg border p-3"
          >
            <div className="flex items-baseline gap-2">
              <span className="bg-primary/10 text-primary rounded px-1.5 py-0.5 font-mono text-xs tabular-nums">
                [{i + 1}]
              </span>
              <FileTextIcon className="text-muted-foreground size-3.5 shrink-0" />
              <span className="text-foreground truncate text-sm font-medium">{doc.docTitle}</span>
              {badges.length > 0 && (
                <div className="ms-auto flex gap-1">
                  {badges.map((b) => (
                    <span
                      key={b}
                      className="text-muted-foreground rounded border border-border/60 px-1 py-0.5 text-[10px] uppercase tracking-wide"
                    >
                      {b}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <p className="text-muted-foreground text-xs leading-relaxed">
              {chunkPreview(doc.content)}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
