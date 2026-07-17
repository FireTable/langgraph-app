"use client";

import { NetworkIcon } from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";

import { CardShell, CardHeader } from "@/components/tool-ui/primitives/card";

import { KbChunkList } from "./chunk-list";
import { parseKbResult } from "./parser";
import { KbSearchToolUI } from "./search-kb-card";

type SearchArgs = { query?: string; topK?: number };

// search_graph returns the same { documents[] } shape as search_kb —
// only the header relabels to reflect graph traversal.

export const KbGraphToolUI: ToolCallMessagePartComponent<SearchArgs> = (props) => {
  const outcome = parseKbResult(props.result);
  if (outcome.kind === "ok") {
    return (
      <CardShell data-slot="kb-graph-card" maxWidthClass="max-w-2xl">
        <CardHeader
          icon={<NetworkIcon className="size-4" />}
          title={`Graph search · ${outcome.result.documents.length} ${
            outcome.result.documents.length === 1 ? "chunk" : "chunks"
          }`}
          subtitle={props.args?.query?.trim() ? `"${props.args.query.trim()}"` : "entity lookup"}
        />
        <KbChunkList docs={outcome.result.documents} slot="kb-graph-chunk" />
      </CardShell>
    );
  }
  // loading / empty / error: share chrome with search_kb.
  return <KbSearchToolUI {...props} />;
};
