"use client";

import { useEffect, useState } from "react";
import {
  ChevronDownIcon,
  ImageIcon,
  MessageSquareIcon,
  HashIcon,
  MaximizeIcon,
} from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";

import { useCanvas } from "@/lib/canvas/context";
import { CardHeader, CardShell } from "@/components/tool-ui/primitives/card";
import { ErrorBanner } from "@/components/tool-ui/primitives/banners";
import { unwrapToolResult } from "@/components/tool-ui/tool-result";

// ponytail: generate_image tool result lands as either a success
// payload ({ urls[], mock, prompt, aspect_ratio, num }) or a failure
// payload ({ success: false, error }). The card reads useCanvas() to
// wire the "Add to canvas" button — when the canvas is closed
// (ready: false) the button is disabled with a tooltip rather than
// auto-opening, matching the user-chosen minimal flow (no auto-open).
//
// Dedup: `useState` resets every remount; StrictMode dev double-mount,
// thread-switch rehydrate, and result-streaming re-renders would all
// re-fire the auto-add effect and stack duplicate Preview nodes on
// the canvas. We keep a module-level Set keyed by toolCallId so the
// effect can short-circuit on subsequent mounts of the same call.

type Args = {
  prompt: string;
  aspect_ratio?: "square" | "portrait" | "landscape";
  num?: number;
};

type Success = {
  urls: string[];
  mock: boolean;
  prompt: string;
  aspect_ratio: "square" | "portrait" | "landscape";
  num: number;
};

type Failure = { success: false; error: string };

type Result = Success | Failure;

type Parsed =
  | { kind: "loading" }
  | { kind: "ok"; payload: Success }
  | { kind: "error"; message: string };

const insertedToolCallIds = new Set<string>();

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
    Array.isArray(obj.urls) &&
    obj.urls.every((u): u is string => typeof u === "string") &&
    typeof obj.prompt === "string" &&
    (obj.aspect_ratio === "square" ||
      obj.aspect_ratio === "portrait" ||
      obj.aspect_ratio === "landscape")
  ) {
    return {
      kind: "ok",
      payload: {
        urls: obj.urls,
        mock: obj.mock === true,
        prompt: obj.prompt,
        aspect_ratio: obj.aspect_ratio,
        num: typeof obj.num === "number" ? obj.num : obj.urls.length,
      },
    };
  }
  return { kind: "loading" };
}

// ponytail: aspect_ratio → image w/h. Square stays at the 512 default;
// portrait / landscape scale one axis. We don't try to fetch the image
// to read its real dimensions — the LLM promises the schema, the tool
// returns it, and the renderer happily re-renders if the URL turns out
// to be the wrong size.
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

// ponytail: kb-card-style collapsible panel that lists the args the
// model chose (prompt / num / aspect_ratio). Hidden when the prompt
// is the only populated field — a single-prompt card with a 3-row
// panel is noise. Stays open by default; the model picked these
// params intentionally so the user usually wants to see them.
function GenInputs({ args }: { args: Args }) {
  const [open, setOpen] = useState(true);
  const prompt = args.prompt?.trim();
  const num = args.num;
  const aspect = args.aspect_ratio;

  if (!prompt && !num && !aspect) return null;

  return (
    <div className="flex flex-col text-xs">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center gap-1.5 text-left text-[11px] font-medium text-muted-foreground/80 hover:text-foreground transition-colors cursor-pointer w-fit"
      >
        <ChevronDownIcon
          className={`size-3.5 shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
        <span>{open ? "Hide generation parameters" : "Open generation parameters"}</span>
      </button>

      {open && (
        <div className="flex flex-col gap-2 pt-2 pl-5">
          {prompt && (
            <div className="grid grid-cols-[82px_1fr] items-start text-left gap-1">
              <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/80 select-none pt-0.5">
                <MessageSquareIcon className="size-3 shrink-0 text-muted-foreground/70" />
                <span>prompt</span>
              </span>
              <span className="text-foreground/90 font-medium break-words leading-relaxed">
                {prompt}
              </span>
            </div>
          )}

          {typeof num === "number" && num > 1 && (
            <div className="grid grid-cols-[82px_1fr] items-start text-left gap-1">
              <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/80 select-none pt-0.5">
                <HashIcon className="size-3 shrink-0 text-muted-foreground/70" />
                <span>num</span>
              </span>
              <span className="text-foreground/90 font-medium">
                {num} {num === 1 ? "variant" : "variants"}
              </span>
            </div>
          )}

          {aspect && (
            <div className="grid grid-cols-[82px_1fr] items-start text-left gap-1">
              <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/80 select-none pt-0.5">
                <MaximizeIcon className="size-3 shrink-0 text-muted-foreground/70" />
                <span>ratio</span>
              </span>
              <span className="text-foreground/90 font-medium font-mono">{aspect}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const GenerateImageCard: ToolCallMessagePartComponent<Args, Result> = ({
  toolCallId,
  args,
  result,
}) => {
  const parsed = parseResult(result);
  const { ready: canvasReady, insertImage, addEdge, getSourceNode } = useCanvas();
  // ponytail: drop position helpers. We anchor each Preview directly
  // below the upstream Generate node (recorded when the user clicked
  // Send on it) so the system edge reads as a clean top→bottom flow.
  // Multi-variant calls fan out horizontally under the source — 20px
  // gap per variant so they don't overlap. When the source position
  // is unknown (no Generate node, or Send was clicked before the
  // bridge had a chance to register), fall back to the canvas's
  // default viewport-center behavior by passing no position.
  // ponytail: getSourceNode() nests x/y under .position (xyflow node
  // shape). Read those directly — the flat-shape signature was a
  // leftover from when we tracked the id only.
  const previewPositions = (
    sourcePos: {
      id: string;
      position: { x: number; y: number };
      width?: number;
      height?: number;
    } | null,
  ) => {
    if (!sourcePos) return null;
    const baseY = sourcePos.position.y + (sourcePos.height ?? 100) + 40;
    const baseX = sourcePos.position.x;
    return (idx: number) => ({ x: baseX + idx * 20, y: baseY });
  };
  // ponytail: ALL hooks above early returns. The auto-add below only
  // fires when the result is "ok" (loading/error return before we
  // touch insertImage). The effect itself is a no-op in those cases
  // because `urls` and other deps are undefined — the early returns
  // above handle the "don't insert" semantics for the visual UI.
  useEffect(() => {
    if (!canvasReady) return;
    if (insertedToolCallIds.has(toolCallId)) return;
    if (parsed.kind !== "ok") return;
    insertedToolCallIds.add(toolCallId);

    const { urls, aspect_ratio } = parsed.payload;
    const dims = dimsFor(aspect_ratio);
    const source = getSourceNode();
    const pos = previewPositions(source);
    urls.forEach((url, idx) => {
      // ponytail: 1/2 linear (1/4 area) preview — the chat bubble
      // shows the full-size image, the canvas just needs a reference
      // shape. Halve w/h at insert so the Preview node + image
      // render compactly side-by-side.
      const previewId = insertImage({
        url,
        w: dims.w / 2,
        h: dims.h / 2,
        position: pos ? pos(idx) : undefined,
      });
      if (previewId && source) {
        addEdge({ source: source.id, target: previewId, system: true });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasReady, parsed.kind, toolCallId]);

  if (parsed.kind === "loading") {
    return (
      <CardShell data-slot="generate-image-loading">
        <CardHeader
          icon={<ImageIcon className="size-4 animate-pulse" />}
          title="Generating image…"
          subtitle={args.prompt ? `prompt · ${args.aspect_ratio ?? "square"}` : undefined}
        />
        <GenInputs args={args ?? {}} />
      </CardShell>
    );
  }
  if (parsed.kind === "error") {
    return (
      <CardShell data-slot="generate-image-error">
        <ErrorBanner message={`Image generation failed: ${parsed.message}`} />
      </CardShell>
    );
  }

  const { urls, prompt, aspect_ratio, mock, num } = parsed.payload;
  const dims = dimsFor(aspect_ratio);
  // ponytail: 1 → single column full-width. 2 → side-by-side. 3-4 →
  // 2-column grid. The grid keeps the card visually compact when the
  // model emits multiple variants.
  const gridClass =
    urls.length <= 1
      ? "grid grid-cols-1 gap-2"
      : urls.length === 2
        ? "grid grid-cols-2 gap-2"
        : "grid grid-cols-2 gap-2";

  // ponytail: no Add / Open-source buttons. The auto-add effect above
  // already inserts the previews onto the canvas (and re-runs when the
  // canvas opens, since `canvasReady` is in its deps). Manual buttons
  // added noise — the user has no reason to re-add what already exists,
  // and the source URL is right there as the <img> src.

  const subtitle = mock
    ? `Demo image${num > 1 ? "s" : ""} (no FAL_KEY configured)`
    : `${num > 1 ? `${num} variants · ` : ""}${aspect_ratio} · ${dims.w}×${dims.h}`;

  return (
    <CardShell data-slot="generate-image">
      <CardHeader
        icon={<ImageIcon className="size-4" />}
        title="Generated image"
        subtitle={subtitle}
      />
      <GenInputs args={args ?? {}} />
      {/* ponytail: rule #6 — no mx-*, no shadow-*. Images are the
          primary artifact; the grid is compact when variants > 1. */}
      <div className={gridClass}>
        {urls.map((url, idx) => (
          <div
            key={`${toolCallId}-${idx}`}
            className="overflow-hidden rounded-lg border border-border/60 bg-muted/40"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt={`${prompt}${num > 1 ? ` (${idx + 1}/${num})` : ""}`}
              width={dims.w}
              height={dims.h}
              className="block h-auto w-full"
            />
          </div>
        ))}
      </div>
      {urls.length === 1 && <p className="text-muted-foreground text-xs">{prompt}</p>}
    </CardShell>
  );
};
