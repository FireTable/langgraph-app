"use client";

import { LoaderIcon, SearchIcon } from "lucide-react";
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
  if (args?.rewriteQuery?.trim()) return `"${args.rewriteQuery.trim()}"`;
  if (args?.documentId) return "this document";
  if (args?.folderId) return "this folder";
  return "your documents";
}

// ponytail: rule 6 — tool-UI cards stay flush with the container,
// no `mx-*` / no `shadow-*`. Chips are bare text labels with a
// subtle muted background. Rule 7 — text-only buttons; the icons
// here are decorative separators, not actionable.
function SearchInputs({ args }: { args: SearchArgs }) {
  const hasOriginal =
    Boolean(args.originalQuery?.trim()) && args.originalQuery?.trim() !== args.rewriteQuery?.trim();
  const entities = args.entities ?? [];
  const themes = args.themes ?? [];
  if (!args.rewriteQuery?.trim() && !hasOriginal && entities.length === 0 && themes.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pb-3 text-xs text-muted-foreground">
      {args.rewriteQuery?.trim() && <span className="font-mono">q={args.rewriteQuery.trim()}</span>}
      {hasOriginal && (
        <>
          <span aria-hidden="true">·</span>
          <span className="font-mono" title="verbatim user message for multi-query fusion">
            orig={args.originalQuery!.trim()}
          </span>
        </>
      )}
      {entities.length > 0 && (
        <>
          <span aria-hidden="true">·</span>
          <span className="flex flex-wrap items-center gap-1">
            <span>entities:</span>
            {entities.map((e) => (
              <span key={`e-${e}`} className="rounded bg-muted px-1.5 py-0.5 text-foreground">
                {e}
              </span>
            ))}
          </span>
        </>
      )}
      {themes.length > 0 && (
        <>
          <span aria-hidden="true">·</span>
          <span className="flex flex-wrap items-center gap-1">
            <span>themes:</span>
            {themes.map((t) => (
              <span key={`t-${t}`} className="rounded bg-muted px-1.5 py-0.5 text-foreground">
                {t}
              </span>
            ))}
          </span>
        </>
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
        title={`KB search · ${docs.length} ${docs.length === 1 ? "chunk" : "chunks"}`}
        subtitle={queryLabel}
      />
      <SearchInputs args={args ?? {}} />
      <KbChunkList docs={docs} slot="kb-search-chunk" />
    </CardShell>
  );
};
