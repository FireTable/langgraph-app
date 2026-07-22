"use client";

import { useState } from "react";
import {
  LoaderIcon,
  SearchIcon,
  ChevronDownIcon,
  MessageSquareIcon,
  SparklesIcon,
  TagIcon,
  LayersIcon,
} from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";

import { CardShell, CardHeader } from "@/components/tool-ui/primitives/card";

import { KbChunkList } from "./chunk-list";
import { parseKbResult } from "./parser";

// ponytail: tool args after audit Step 1 — query → rewriteQuery +
// originalQuery + entities + themes. The schema lives in
// components/tool-ui/toolkit.tsx (kept in sync, the toolkit parses
// raw tool args before handing them to this component).
type SearchArgs = {
  rewriteQuery?: string;
  originalQuery?: string;
  entities?: string[];
  themes?: string[];
  folderId?: string;
  documentId?: string;
};

// ponytail: KB tool UI (issue #13 v3). Renders the structured ToolMessage
// payload returned by backend/tool/kb.ts: { content, documents[], empty }.
// `content` is the LLM-facing string; hidden here because the assistant
// message already quotes it inline. `documents[]` drives the cards.

// ponytail: subtitle wording across loading / empty / result states.
// With a real query the user gets the question text; without a query
// we name the scope that was dumped (document > folder > everything)
// so the user understands what they're looking at — and the matching
// "full doc" badge on each chunk row reinforces the same intent.
function scopeLabel(args: SearchArgs | undefined): string {
  if (args?.documentId) return "Search in target document";
  if (args?.folderId) return "Search in target folder";
  return "Search in knowledge base";
}

// ponytail: rule 6 — tool-UI cards stay flush with the container,
// no `mx-*` / no `shadow-*`. Chips are bare text labels with a
// subtle muted background. Rule 7 — text-only buttons; the icons
// here are decorative separators, not actionable.
function SearchInputs({ args }: { args: SearchArgs }) {
  const [open, setOpen] = useState(true);

  const original = args.originalQuery?.trim();
  const rewrite = args.rewriteQuery?.trim();
  const entities = args.entities ?? [];
  const themes = args.themes ?? [];

  if (!original && !rewrite && entities.length === 0 && themes.length === 0) {
    return null;
  }

  const badgeCounts = [
    entities.length > 0 ? `${entities.length} entries` : null,
    themes.length > 0 ? `${themes.length} themes` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex flex-col text-xs ">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center gap-1.5 text-left text-[11px] font-medium text-muted-foreground/80 hover:text-foreground transition-colors cursor-pointer w-fit"
      >
        <ChevronDownIcon
          className={`size-3.5 shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
        <span>{open ? "Hide search parameters" : "Open search parameters"}</span>
        {badgeCounts && (
          <span className="text-[10px] text-muted-foreground/70 bg-muted/60 border border-border/40 px-1.5 py-0.5 rounded font-mono ml-1">
            {badgeCounts}
          </span>
        )}
      </button>

      {open && (
        <div className="flex flex-col gap-2 pt-2 pl-5">
          {/* 1. original */}
          {original && (
            <div className="grid grid-cols-[82px_1fr] items-start text-left gap-1">
              <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/80 select-none pt-0.5">
                <MessageSquareIcon className="size-3 shrink-0 text-muted-foreground/70" />
                <span>original</span>
              </span>
              <span className="text-foreground/90 font-medium break-words leading-relaxed">
                {original}
              </span>
            </div>
          )}

          {/* 2. rewrite */}
          {rewrite && (
            <div className="grid grid-cols-[82px_1fr] items-start text-left gap-1">
              <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/80 select-none pt-0.5">
                <SparklesIcon className="size-3 shrink-0 text-muted-foreground/70" />
                <span>rewrite</span>
              </span>
              <span className="text-foreground/90 font-medium break-words leading-relaxed">
                {rewrite}
              </span>
            </div>
          )}

          {/* 3. entries (entities) */}
          {entities.length > 0 && (
            <div className="grid grid-cols-[82px_1fr] items-start text-left gap-1">
              <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/80 select-none pt-0.5">
                <TagIcon className="size-3 shrink-0 text-muted-foreground/70" />
                <span>entries</span>
              </span>
              <div className="flex flex-wrap items-center gap-1.5 text-left">
                {entities.map((e) => (
                  <span
                    key={`e-${e}`}
                    className="bg-muted text-foreground/80 border border-border/50 rounded px-2 py-0.5 text-[11px] font-medium"
                  >
                    {e}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 4. themes */}
          {themes.length > 0 && (
            <div className="grid grid-cols-[82px_1fr] items-start text-left gap-1">
              <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/80 select-none pt-0.5">
                <LayersIcon className="size-3 shrink-0 text-muted-foreground/70" />
                <span>themes</span>
              </span>
              <div className="flex flex-wrap items-center gap-1.5 text-left">
                {themes.map((t) => (
                  <span
                    key={`t-${t}`}
                    className="bg-muted text-foreground/80 border border-border/50 rounded px-2 py-0.5 text-[11px] font-medium"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const KbSearchToolUI: ToolCallMessagePartComponent<SearchArgs> = ({ result, args }) => {
  const outcome = parseKbResult(result);
  const queryLabel = scopeLabel(args);

  if (outcome.kind === "loading") {
    return (
      <CardShell data-slot="kb-search-card" maxWidthClass="max-w-2xl">
        <CardHeader
          icon={<LoaderIcon className="size-4 animate-spin" />}
          title="Searching KB"
          subtitle={queryLabel}
        />
        <SearchInputs args={args ?? {}} />
      </CardShell>
    );
  }

  if (outcome.kind === "error") {
    return (
      <CardShell data-slot="kb-search-card" maxWidthClass="max-w-2xl">
        <CardHeader
          icon={<SearchIcon className="size-4" />}
          title="Search failed"
          subtitle={outcome.message}
        />
      </CardShell>
    );
  }

  if (outcome.kind === "empty") {
    return (
      <CardShell data-slot="kb-search-card" maxWidthClass="max-w-2xl">
        <CardHeader
          icon={<SearchIcon className="size-4" />}
          title="No KB matches"
          subtitle={`Nothing in the knowledge base matches ${queryLabel}.`}
        />
        <SearchInputs args={args ?? {}} />
      </CardShell>
    );
  }

  const docs = outcome.result.documents;
  return (
    <CardShell data-slot="kb-search-card" maxWidthClass="max-w-2xl">
      <CardHeader
        icon={<SearchIcon className="size-4" />}
        title={`Search KB  · ${docs.length} ${docs.length === 1 ? "chunk" : "chunks"}`}
        subtitle={queryLabel}
      />
      <SearchInputs args={args ?? {}} />
      <KbChunkList docs={docs} slot="kb-search-chunk" />
    </CardShell>
  );
};
