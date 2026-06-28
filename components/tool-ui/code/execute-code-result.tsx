"use client";

import { CheckIcon, Loader2Icon, PlayIcon } from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";

import { unwrapToolResult } from "@/components/tool-ui/tool-result";
import { CodeBlock } from "@/components/assistant-ui/code-block";
import { CardHeader, CardShell } from "@/components/tool-ui/primitives/card";
import { ErrorBanner } from "@/components/tool-ui/primitives/banners";

// ExecuteCodeResult — read-only card showing the result of execute_code.
// No interrupt, no resume — the tool returned, the model writes the final
// sentence. The user already saw the code in the write_code card, so we
// only render the output here (result, stdout, stderr, or error).
// Each output uses the markdown code-block chrome so it matches the rest
// of the chat's code rendering.

type Args = { code: string; input?: unknown; timeoutMs?: number };
type Result =
  | { ok: true; stdout: string; stderr: string; result?: unknown }
  | { ok: false; stdout?: string; stderr?: string; error: string };

function formatValue(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// ponytail: defensive coercion for fields the backend returns. A
// malformed tool result (non-string stdout/stderr) would otherwise
// crash the syntax highlighter on `code.replace`.
const safeText = (v: unknown): string => (typeof v === "string" ? v : formatValue(v));

export const ExecuteCodeResult: ToolCallMessagePartComponent<Args> = ({ args, result, status }) => {
  const parsed = unwrapToolResult<Result>(result);
  const isRunning = status?.type === "running";
  const isIncomplete = status?.type === "incomplete";

  return (
    <CardShell data-slot="execute-code-result">
      <CardHeader
        icon={
          isRunning ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : parsed?.ok === true ? (
            <CheckIcon className="size-4" />
          ) : parsed?.ok === false ? (
            <PlayIcon className="text-destructive size-4" />
          ) : (
            <PlayIcon className="size-4" />
          )
        }
        iconClassName={parsed?.ok === false ? "bg-destructive/10 text-destructive" : undefined}
        title={
          isRunning
            ? "Running…"
            : isIncomplete && !parsed
              ? "Execution interrupted"
              : parsed?.ok === true
                ? "Done"
                : parsed?.ok === false
                  ? "Failed"
                  : "Queued"
        }
        subtitle={`Deno Deploy Sandbox${args.timeoutMs ? ` · ${args.timeoutMs}ms timeout` : " · 10s timeout"}`}
      />

      {parsed?.ok === true && (
        <div className="flex flex-col gap-3">
          {/* ponytail: backend returns `result: stdout` (spawn-based
              capture can't separate console.log from the last-expression
              value). Showing both duplicates the same block. Prefer
              `result` when the model set one, fall back to `stdout`.
              Each section gets its own header label so the user can
              tell Result / Stdout / Stderr apart. */}
          {parsed.result !== undefined ? (
            <CodeBlock language="text" code={formatValue(parsed.result)} label="Result" />
          ) : parsed.stdout ? (
            <CodeBlock language="text" code={safeText(parsed.stdout)} label="Stdout" />
          ) : null}
          {parsed.stderr && (
            <CodeBlock language="text" code={safeText(parsed.stderr)} label="Stderr" />
          )}
        </div>
      )}

      {parsed?.ok === false && <ErrorBanner message={parsed.error} monospace />}
    </CardShell>
  );
};
