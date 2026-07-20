"use client";

import { LoaderIcon, SearchIcon } from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";

import { CardShell, CardHeader } from "@/components/tool-ui/primitives/card";

import { KbChunkList } from "./chunk-list";
import { parseKbResult } from "./parser";

type SearchArgs = { query?: string; folderId?: string; documentId?: string };

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
  if (args?.query?.trim()) return `"${args.query.trim()}"`;
  if (args?.documentId) return "this document";
  if (args?.folderId) return "this folder";
  return "your documents";
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
      <KbChunkList docs={docs} slot="kb-search-chunk" />
    </CardShell>
  );
};
