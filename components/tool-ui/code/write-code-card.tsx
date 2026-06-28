"use client";

import { useState } from "react";
import { Loader2Icon, PlayIcon, XIcon } from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { useLangGraphSendCommand } from "@assistant-ui/react-langgraph";

import { Button } from "@/components/ui/button";
import { unwrapToolResult } from "@/components/tool-ui/tool-result";
import { ToolCardSkeleton } from "@/components/tool-ui/tool-card-skeleton";
import { CodeBlock } from "@/components/assistant-ui/code-block";
import { CardHeader, CardShell } from "@/components/tool-ui/primitives/card";
import { SuccessBanner } from "@/components/tool-ui/primitives/banners";

// WriteCodeCard — the user-side approval point for the code agent.
// The tool pauses via interrupt({ ui: 'write_code' }); the card renders
// the proposed code as a markdown code block (language from args, default
// typescript) plus Run/Cancel. The code is read straight from `args.code`
// on every render so streaming tool-call payloads land in the card without
// a stale-state lag. On Run, the code flows back via useLangGraphSendCommand;
// the model then calls execute_code with that code.
//
// Inlined mode (USE_SUBGRAPH=false): the toolkit's `render` mounts this
// card in the tool-call slot. `addResult` overwrites the ToolMessage
// content — same flow from the user's perspective.
// Subgraph mode (USE_SUBGRAPH=true): the InterruptUI in thread.tsx
// dispatches here based on the interrupt's `ui` field. The card uses
// useLangGraphSendCommand to resume.

type CodeLanguage = "typescript" | "javascript" | "python";
type Args = { code: string; language?: string };
type Resume = { action: "run"; code: string; language: CodeLanguage } | { action: "cancel" };

export const WriteCodeCard: ToolCallMessagePartComponent<Args> = ({ args, result }) => {
  const sendCommand = useLangGraphSendCommand();
  const [submitting, setSubmitting] = useState<"run" | "cancel" | null>(null);

  // ponytail: don't mirror args.code into useState — the tool call streams
  // in and the first render captures an empty value forever. Read the
  // current args on every render so the card shows the latest streamed
  // code without waiting for a re-mount. Coerce non-strings to "" so a
  // malformed tool call (object / null / undefined) doesn't crash the
  // syntax highlighter downstream.
  const code = typeof args?.code === "string" ? args.code : "";
  // ponytail: language comes from the model. Coerce to the allowed union
  // so a stray string from a future model version doesn't crash the
  // resume payload. Anything unrecognized falls back to typescript — same
  // default the tool schema uses.
  const language: CodeLanguage =
    args?.language === "javascript" || args?.language === "python" ? args.language : "typescript";
  const awaitingCode = code.trim().length === 0;

  const resolved = unwrapToolResult<{ action: string }>(result) != null;
  const ran = resolved && unwrapToolResult<{ action: string }>(result)?.action === "run";

  const resume = (payload: Resume) => {
    sendCommand({ resume: payload as never });
  };

  const handleRun = () => {
    setSubmitting("run");
    resume({ action: "run", code, language });
  };

  const handleCancel = () => {
    setSubmitting("cancel");
    resume({ action: "cancel" });
  };

  return (
    <CardShell data-slot="write-code-card">
      <CardHeader
        icon={<PlayIcon className="size-4" />}
        title={ran ? "Running…" : resolved ? "Cancelled" : "Review the code"}
        subtitle={
          ran
            ? "Executing in Deno Deploy Sandbox."
            : resolved
              ? "No code was run."
              : "Click Run to execute, or Cancel."
        }
      />

      {awaitingCode ? (
        <ToolCardSkeleton label="Awaiting code…" />
      ) : (
        <CodeBlock language={language} code={code} />
      )}

      {!resolved && (
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleCancel}
            disabled={submitting != null}
            className="flex-1"
          >
            Skip run
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleRun}
            disabled={submitting != null || awaitingCode}
            className="flex-1"
          >
            {submitting === "run" ? (
              <>
                <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
                Running
              </>
            ) : (
              "Run in sandbox"
            )}
          </Button>
        </div>
      )}

      {ran && <SuccessBanner title="Run requested — waiting for result." />}

      {resolved && !ran && (
        <SuccessBanner
          title="Cancelled. The model will be notified."
          icon={<XIcon className="text-muted-foreground size-5 shrink-0" />}
          className="text-muted-foreground"
        />
      )}
    </CardShell>
  );
};
