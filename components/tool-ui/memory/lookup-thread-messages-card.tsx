"use client";

import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { HistoryIcon, MessageSquareIcon } from "lucide-react";

import { CardHeader, CardShell } from "@/components/tool-ui/primitives/card";
import { ErrorBanner } from "@/components/tool-ui/primitives/banners";
import { unwrapToolResult } from "@/components/tool-ui/tool-result";

type Args = {
  refs?: string | string[];
  includeToolMessages?: boolean;
};

type RehydratedTurn = {
  ref: string;
  messages: Array<{
    role: string;
    content: string;
    toolCalls?: unknown;
  }>;
};

type EntryResult = {
  refTags: string[];
  question: string;
  answer: string;
  coveredRange: string;
};

type Result = {
  ok: boolean;
  queryRefs?: string | string[];
  matchCount?: number;
  turns?: RehydratedTurn[];
  entries?: EntryResult[];
  error?: string;
};

function parseResult(
  raw: unknown,
): { kind: "ok"; result: Result } | { kind: "error"; message: string } | { kind: "loading" } {
  const obj = unwrapToolResult<unknown>(raw);
  if (!obj || typeof obj !== "object") return { kind: "loading" };
  const o = obj as Record<string, unknown>;
  if (o.status === "error") {
    const content = typeof o.content === "string" ? o.content : "Tool failed.";
    const message = content.replace(/^Error:\s*/, "").trim();
    return { kind: "error", message };
  }
  if (o.ok === false && typeof o.error === "string") {
    return { kind: "error", message: o.error };
  }
  if (o.ok === true && (Array.isArray(o.turns) || Array.isArray(o.entries))) {
    return { kind: "ok", result: o as unknown as Result };
  }
  return { kind: "loading" };
}

function formatRefLabel(refs?: string | string[]): string {
  if (!refs) return "";
  if (Array.isArray(refs)) return refs.join(", ");
  return refs;
}

function formatRoleName(role: string): string {
  if (!role) return "Unknown";
  if (role === "human" || role === "user") return "User";
  if (role === "ai" || role === "assistant") return "Assistant";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export const LookupThreadMessagesCard: ToolCallMessagePartComponent<Args> = ({ result, args }) => {
  const parsed = parseResult(result);
  const refLabel = formatRefLabel(args?.refs);

  if (parsed.kind === "loading") {
    return (
      <CardShell data-slot="lookup-thread-messages-card-loading" maxWidthClass="max-w-md">
        <CardHeader
          icon={<HistoryIcon className="size-4" />}
          title="Looking up history"
          subtitle={
            refLabel
              ? `Rehydrating raw messages for ${refLabel}…`
              : "Rehydrating raw history messages…"
          }
        />
      </CardShell>
    );
  }

  if (parsed.kind === "error") {
    return (
      <CardShell data-slot="lookup-thread-messages-card-error" maxWidthClass="max-w-md">
        <CardHeader
          icon={<HistoryIcon className="size-4" />}
          title="History lookup failed"
          subtitle={refLabel ? `Target ref: ${refLabel}` : undefined}
        />
        <ErrorBanner message={parsed.message} monospace />
      </CardShell>
    );
  }

  const turns = parsed.result.turns ?? [];
  const entries = parsed.result.entries ?? [];
  const count = turns.length > 0 ? turns.length : entries.length;

  return (
    <CardShell data-slot="lookup-thread-messages-card" maxWidthClass="max-w-lg">
      <CardHeader
        icon={<HistoryIcon className="size-4" />}
        title="Raw history messages rehydrated"
        subtitle={`Rehydrated ${count} ${count === 1 ? "turn" : "turns"} for ${refLabel || "history"}`}
      />

      <div className="flex flex-col divide-y divide-border/60">
        {turns.map((turn, idx) => (
          <div key={idx} className="flex flex-col gap-1.5 py-2.5 text-xs first:pt-0 last:pb-0">
            <div className="flex items-center gap-1 font-mono font-medium text-foreground">
              <MessageSquareIcon className="size-3 text-primary" />
              <span>Turn {turn.ref}</span>
            </div>

            {turn.messages.map((m, mIdx) => {
              const isUser = m.role === "human" || m.role === "user";
              const displayRole = formatRoleName(m.role);
              return (
                <div
                  key={mIdx}
                  className={`rounded-md p-2 font-mono text-[11px] leading-relaxed ${
                    isUser ? "bg-muted/60 text-foreground/90" : "bg-muted/30 text-foreground/80"
                  }`}
                >
                  <span
                    className={`font-semibold ${
                      isUser ? "text-primary" : "text-emerald-600 dark:text-emerald-400"
                    }`}
                  >
                    {displayRole}:{" "}
                  </span>
                  {m.content}
                </div>
              );
            })}
          </div>
        ))}

        {turns.length === 0 &&
          entries.map((entry, idx) => (
            <div key={idx} className="flex flex-col gap-1.5 py-2.5 text-xs first:pt-0 last:pb-0">
              <div className="flex items-center justify-between gap-2 text-muted-foreground">
                <span className="inline-flex items-center gap-1 font-mono font-medium text-foreground">
                  <MessageSquareIcon className="size-3 text-primary" />
                  {entry.refTags.join(", ")}
                </span>
                <span className="font-mono text-[10px] opacity-70">{entry.coveredRange}</span>
              </div>

              <div className="bg-muted/50 rounded-md p-2 text-foreground/90 font-mono text-[11px] leading-relaxed">
                <span className="font-semibold text-primary">Q: </span>
                {entry.question}
              </div>

              <div className="bg-muted/30 rounded-md p-2 text-foreground/80 font-mono text-[11px] leading-relaxed">
                <span className="font-semibold text-emerald-600 dark:text-emerald-400">A: </span>
                {entry.answer}
              </div>
            </div>
          ))}
      </div>
    </CardShell>
  );
};
