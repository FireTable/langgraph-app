"use client";

import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { CheckIcon, PlusIcon, SaveIcon, Trash2Icon } from "lucide-react";

import { CardHeader, CardShell } from "@/components/tool-ui/primitives/card";
import { ErrorBanner } from "@/components/tool-ui/primitives/banners";
import { unwrapToolResult } from "@/components/tool-ui/tool-result";
import { prettifyKey } from "@/lib/memory/format";

type Args = { patches?: Array<{ op: string; path: string; value?: unknown }> };

type Patch =
  | { op: "add"; path: string; value: unknown }
  | { op: "replace"; path: string; oldValue?: unknown; value: unknown }
  | { op: "remove"; path: string; oldValue?: unknown };

type Result = {
  ok: true;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  patches: Patch[];
};

// LangGraph's ToolNode wraps thrown errors as `{status:"error", content:...}`.
// Surface those as a structured error so the card can render the same chrome
// the rest of the tool-ui uses, instead of falling into the loading skeleton.
function parseResult(
  raw: unknown,
): { kind: "ok"; result: Result } | { kind: "error"; message: string } | { kind: "loading" } {
  const obj = unwrapToolResult<unknown>(raw);
  if (!obj || typeof obj !== "object") return { kind: "loading" };
  const o = obj as Record<string, unknown>;
  if (o.status === "error") {
    const content = typeof o.content === "string" ? o.content : "Tool failed.";
    // ponytail: LangGraph prefixes thrown errors with "Error: " — strip it
    // so the card shows the real message.
    const message = content.replace(/^Error:\s*/, "").trim();
    return { kind: "error", message };
  }
  if (o.ok === true && Array.isArray(o.patches)) {
    return { kind: "ok", result: o as unknown as Result };
  }
  return { kind: "loading" };
}

function displayValue(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function summaryLabel(patches: Patch[]): string {
  const adds = patches.filter((p) => p.op === "add").length;
  const replaces = patches.filter((p) => p.op === "replace").length;
  const removes = patches.filter((p) => p.op === "remove").length;
  const parts: string[] = [];
  if (adds > 0) parts.push(`${adds} added`);
  if (replaces > 0) parts.push(`${replaces} updated`);
  if (removes > 0) parts.push(`${removes} removed`);
  return parts.length > 0 ? parts.join(" · ") : "No changes";
}

export const SaveMemoryCard: ToolCallMessagePartComponent<Args> = ({ result, args }) => {
  const parsed = parseResult(result);
  const patchCount = args?.patches?.length ?? 0;

  if (parsed.kind === "loading") {
    return (
      <CardShell data-slot="save-memory-card-loading" maxWidthClass="max-w-md">
        <CardHeader
          icon={<SaveIcon className="size-4" />}
          title="Saving to memory"
          subtitle={`Applying ${patchCount} ${patchCount === 1 ? "change" : "changes"}…`}
        />
      </CardShell>
    );
  }

  if (parsed.kind === "error") {
    return (
      <CardShell data-slot="save-memory-card-error" maxWidthClass="max-w-md">
        <CardHeader
          icon={<SaveIcon className="size-4" />}
          title="Couldn't save to memory"
          subtitle="The assistant will retry or surface the error."
        />
        <ErrorBanner message={parsed.message} monospace />
      </CardShell>
    );
  }

  return (
    <CardShell data-slot="save-memory-card" maxWidthClass="max-w-md">
      <CardHeader
        icon={<SaveIcon className="size-4" />}
        title="Memory updated"
        subtitle={summaryLabel(parsed.result.patches)}
      />

      <ul className="flex flex-col">
        {parsed.result.patches.map((patch, i) => (
          <DiffRow key={`${patch.path}-${i}`} patch={patch} />
        ))}
      </ul>
    </CardShell>
  );
};

function DiffRow({ patch }: { patch: Patch }) {
  if (patch.op === "add") {
    return (
      <li className="border-border/60 flex items-start gap-3 border-t py-2 text-sm first:border-t-0">
        <span className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-md">
          <PlusIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-foreground/90 text-sm font-medium tracking-wide">
            Added
            <span className="bg-muted text-foreground ml-2 rounded-md px-1.5 py-0.5 font-mono text-xs tracking-normal">
              {prettifyKey(patch.path)}
            </span>
          </p>
          <p className="text-foreground mt-0.5 font-mono text-xs break-words">
            {displayValue(patch.value)}
          </p>
        </div>
      </li>
    );
  }
  if (patch.op === "remove") {
    return (
      <li className="border-border/60 flex items-start gap-3 border-t py-2 text-sm first:border-t-0">
        <span className="bg-rose-500/10 text-rose-600 dark:text-rose-400 mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-md">
          <Trash2Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-foreground/90 text-sm font-medium tracking-wide">
            Removed
            <span className="bg-muted text-foreground ml-2 rounded-md px-1.5 py-0.5 font-mono text-xs tracking-normal">
              {prettifyKey(patch.path)}
            </span>
          </p>
          {patch.oldValue !== undefined && (
            <p className="text-muted-foreground mt-0.5 font-mono text-xs line-through break-words">
              {displayValue(patch.oldValue)}
            </p>
          )}
        </div>
      </li>
    );
  }
  return (
    <li className="border-border/60 flex items-start gap-3 border-t py-2 text-sm first:border-t-0">
      <span className="bg-amber-500/10 text-amber-600 dark:text-amber-400 mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-md">
        <CheckIcon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-foreground/90 text-sm font-medium tracking-wide">
          Changed
          <span className="bg-muted text-foreground ml-2 rounded-md px-1.5 py-0.5 font-mono text-xs tracking-normal">
            {prettifyKey(patch.path)}
          </span>
        </p>
        <div className="mt-0.5 flex flex-col gap-1 font-mono text-xs">
          {patch.oldValue !== undefined && (
            <span className="text-muted-foreground line-through break-words">
              {displayValue(patch.oldValue)}
            </span>
          )}
          {patch.oldValue !== undefined && (
            <span className="text-muted-foreground text-center" aria-hidden>
              ↓
            </span>
          )}
          <span className="text-foreground break-words">{displayValue(patch.value)}</span>
        </div>
      </div>
    </li>
  );
}
