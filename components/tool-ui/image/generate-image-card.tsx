"use client";

import { useEffect, useState } from "react";
import { ImageIcon } from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";

import { useCanvas } from "@/lib/canvas/context";
import { CardHeader, CardShell } from "@/components/tool-ui/primitives/card";
import { ErrorBanner } from "@/components/tool-ui/primitives/banners";
import { ToolCardSkeleton } from "@/components/tool-ui/tool-card-skeleton";
import { unwrapToolResult } from "@/components/tool-ui/tool-result";

// ponytail: generate_image tool result lands as either a success
// payload ({ url, mock, prompt, aspect_ratio }) or a failure payload
// ({ success: false, error }). The card reads useCanvas() to wire the
// "Add to canvas" button — when the canvas is closed (ready: false)
// the button is disabled with a tooltip rather than auto-opening,
// matching the user-chosen minimal flow (no auto-open).

type Args = {
  prompt: string;
  aspect_ratio?: "square" | "portrait" | "landscape";
};

type Success = {
  url: string;
  mock: boolean;
  prompt: string;
  aspect_ratio: "square" | "portrait" | "landscape";
};

type Failure = { success: false; error: string };

type Result = Success | Failure;

type Parsed =
  | { kind: "loading" }
  | { kind: "ok"; payload: Success }
  | { kind: "error"; message: string };

function parseResult(raw: unknown): Parsed {
  // ponytail: same untyped-Record pattern as kb/parser.ts. Casting
  // through `Result` makes the union ambiguous (Failure lacks url/prompt
  // so the narrowing inside can't disambiguate Success); reading off
  // Record<string, unknown> and asserting Success only on success is
  // the canonical way to keep TS happy.
  const obj = unwrapToolResult<Record<string, unknown>>(raw);
  if (!obj) return { kind: "loading" };
  if (obj.success === false && typeof obj.error === "string") {
    return { kind: "error", message: obj.error };
  }
  if (
    typeof obj.url === "string" &&
    typeof obj.prompt === "string" &&
    (obj.aspect_ratio === "square" ||
      obj.aspect_ratio === "portrait" ||
      obj.aspect_ratio === "landscape")
  ) {
    return { kind: "ok", payload: obj as unknown as Success };
  }
  return { kind: "loading" };
}

// ponytail: aspect_ratio → tldraw w/h. Square stays at the 512 default;
// portrait / landscape scale one axis. We don't try to fetch the image
// to read its real dimensions — the LLM promises the schema, the tool
// returns it, and tldraw happily re-renders if the URL turns out to be
// the wrong size.
function dimsFor(aspect: Success["aspect_ratio"]): { w: number; h: number } {
  switch (aspect) {
    case "portrait":
      return { w: 384, h: 512 };
    case "landscape":
      return { w: 512, h: 384 };
    case "square":
    default:
      return { w: 512, h: 512 };
  }
}

export const GenerateImageCard: ToolCallMessagePartComponent<Args, Result> = ({ result }) => {
  const parsed = parseResult(result);
  const { ready: canvasReady, insertImage, addEdge, getSourceNodeId } = useCanvas();
  // ponytail: one-shot success flag — flips after the first click and
  // stays flipped so the button text reads "Added to canvas". Repeated
  // clicks would just stack more shapes (user's choice, not a bug).
  const [added, setAdded] = useState(false);

  // ponytail: ALL hooks above early returns. The auto-add below only
  // fires when the result is "ok" (loading/error return before we
  // touch insertImage). The effect itself is a no-op in those cases
  // because `url` and other deps are undefined — the early returns
  // above handle the "don't insert" semantics for the visual UI.
  useEffect(() => {
    if (!canvasReady || added) return;
    if (parsed.kind !== "ok") return;
    const { url, aspect_ratio } = parsed.payload;
    const dims = dimsFor(aspect_ratio);
    const previewId = insertImage({ url, w: dims.w, h: dims.h });
    if (previewId) {
      const sourceId = getSourceNodeId();
      if (sourceId) {
        addEdge({ source: sourceId, target: previewId, system: true });
      }
      setAdded(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasReady, parsed.kind]);

  if (parsed.kind === "loading") {
    return <ToolCardSkeleton label="Generating image…" />;
  }
  if (parsed.kind === "error") {
    return (
      <CardShell data-slot="generate-image-error">
        <ErrorBanner message={`Image generation failed: ${parsed.message}`} />
      </CardShell>
    );
  }

  const { url, prompt, aspect_ratio, mock } = parsed.payload;
  const dims = dimsFor(aspect_ratio);

  const handleAdd = () => {
    if (!canvasReady || added) return;
    const previewId = insertImage({ url, w: dims.w, h: dims.h });
    if (previewId) {
      const sourceId = getSourceNodeId();
      if (sourceId) {
        addEdge({ source: sourceId, target: previewId, system: true });
      }
    }
    setAdded(true);
  };

  // ponytail: button label mirrors three states — canvas closed, ready
  // to add, just added. We don't reset on canvas close; once "Added"
  // it stays "Added" until the message unmounts.
  const buttonLabel = !canvasReady
    ? "Open canvas to add"
    : added
      ? "Added to canvas"
      : "Add another";

  return (
    <CardShell data-slot="generate-image">
      <CardHeader
        icon={<ImageIcon className="size-4" />}
        title="Generated image"
        subtitle={
          mock ? "Demo image (no FAL_KEY configured)" : `${aspect_ratio} · ${dims.w}×${dims.h}`
        }
      />
      {/* ponytail: rule #6 — no mx-*, no shadow-*. The image is the
          primary artifact; prompt is rendered small underneath so the
          chat model can still reference what was generated. */}
      <div className="overflow-hidden rounded-lg border border-border/60 bg-muted/40">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={prompt}
          width={dims.w}
          height={dims.h}
          className="block h-auto w-full"
        />
      </div>
      <p className="text-muted-foreground text-xs">{prompt}</p>
      <div className="flex items-center gap-2">
        {/* ponytail: rule #7 — text-only button, no leading icon even
            though lucide is in scope. `disabled` reflects canvasReady. */}
        <button
          type="button"
          disabled={!canvasReady || added}
          className="bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
          onClick={handleAdd}
        >
          {buttonLabel}
        </button>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
        >
          Open source
        </a>
      </div>
    </CardShell>
  );
};
