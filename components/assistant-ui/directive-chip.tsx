"use client";

import { FileTextIcon, FolderIcon, ImageIcon, TypeIcon } from "lucide-react";
import type { ReactElement } from "react";
import { useCanvas } from "@/lib/canvas/context";
import {
  CANVAS_DIRECTIVE_GENERATE_IMAGE,
  CANVAS_DIRECTIVE_IMAGE,
  CANVAS_DIRECTIVE_TEXT,
} from "@/lib/constants";
import { kbMentionFormatter } from "./kb-mention-formatter";

type DirectiveType = string;

// ponytail: shared chip visual used by both the read-only
// DirectiveText (user message bubble) and the editable
// DirectiveComposerInput (composer typing area). aUI's
// kbMentionFormatter.parse is the single source of
// truth — both call sites pass segments into `renderDirectiveSegments`
// so what the user types and what they see after send stay in sync.
//
// `renderDirectiveSegments` is a pure render-prop: given segments, it
// returns a flat array of React elements (text spans + chip spans).
// Unit-tested directly; no DOM mounting required.

export const DIRECTIVE_CHIP_CLASS = [
  "aui-directive-chip",
  "inline-flex",
  "items-center",
  "gap-1",
  "rounded",
  "px-1",
  "py-0.5",
  "align-middle",
  "text-xs",
  "font-medium",
  "border",
].join(" ");

// ponytail: directive types that point at a canvas node. They share
// the same click-to-focus behaviour (pan + select) — `focusNode` on
// the canvas bridge handles both. We pick the chip icon + color per
// type so the user can tell at a glance which kind of node the chip
// references, but the click semantics are identical.
const CANVAS_NODE_DIRECTIVES = new Set([
  CANVAS_DIRECTIVE_TEXT,
  CANVAS_DIRECTIVE_GENERATE_IMAGE,
  CANVAS_DIRECTIVE_IMAGE,
]);

/** Returns the icon component for a given directive type. */
export function getChipIcon(directiveType: DirectiveType) {
  if (directiveType === "kb-folder") return FolderIcon;
  if (directiveType === "kb-document" || directiveType === "kb-doc") return FileTextIcon;
  // ponytail: text directive points at a Text node on the canvas —
  // click-to-navigate lives on the chip, so users can jump from a
  // rendered mention back to the source node.
  if (directiveType === CANVAS_DIRECTIVE_TEXT) return TypeIcon;
  // ponytail: generate-image / image directives both point at image-
  // related canvas nodes — same icon, different colors. generate-
  // image is the source (pink), image is an upstream reference
  // (violet).
  if (directiveType === CANVAS_DIRECTIVE_GENERATE_IMAGE || directiveType === CANVAS_DIRECTIVE_IMAGE)
    return ImageIcon;
  return null;
}

/** Returns the Tailwind color classes for a given directive type. */
export function getChipColorClass(directiveType: DirectiveType): string {
  if (directiveType === "kb-folder") {
    return "bg-indigo-500/10 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-400 border-indigo-500/20 dark:border-indigo-400/30";
  }
  if (directiveType === CANVAS_DIRECTIVE_TEXT) {
    // ponytail: slate/teal so it reads as a canvas-node reference
    // (distinct from KB's emerald/indigo). Only used by the Generate
    // node's auto-inserted upstream refs.
    return "bg-sky-500/10 dark:bg-sky-500/20 text-sky-600 dark:text-sky-400 border-sky-500/20 dark:border-sky-400/30";
  }
  if (directiveType === CANVAS_DIRECTIVE_GENERATE_IMAGE) {
    // ponytail: pink so the Generate node ref reads as a different
    // node-kind than the Text ref (sky). Both share the click-to-
    // navigate behaviour, but visually they belong to different
    // canvas elements.
    return "bg-pink-500/10 dark:bg-pink-500/20 text-pink-600 dark:text-pink-400 border-pink-500/20 dark:border-pink-400/30";
  }
  if (directiveType === CANVAS_DIRECTIVE_IMAGE) {
    // ponytail: violet so the upstream Image/Preview node ref reads
    // distinctly from the Generate node ref (pink). Both use
    // ImageIcon; the color separates source vs reference.
    return "bg-violet-500/10 dark:bg-violet-500/20 text-violet-600 dark:text-violet-400 border-violet-500/20 dark:border-violet-400/30";
  }
  return "bg-emerald-500/10 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 dark:border-emerald-400/30";
}

/** Returns the hover color classes for a clickable canvas-node chip. */
function getChipHoverClass(directiveType: DirectiveType): string {
  if (directiveType === CANVAS_DIRECTIVE_TEXT) {
    return "hover:bg-sky-500/20 dark:hover:bg-sky-500/30";
  }
  if (directiveType === CANVAS_DIRECTIVE_GENERATE_IMAGE) {
    return "hover:bg-pink-500/20 dark:hover:bg-pink-500/30";
  }
  if (directiveType === CANVAS_DIRECTIVE_IMAGE) {
    return "hover:bg-violet-500/20 dark:hover:bg-violet-500/30";
  }
  return "";
}

/** Renders a single directive chip span. Used by both the static renderer and the Lexical chip. */
export function DirectiveChipSpan({
  directiveType,
  label,
  directiveId,
}: {
  directiveType: DirectiveType;
  label: string;
  directiveId?: string;
}): ReactElement {
  const Icon = getChipIcon(directiveType);
  const colorClass = getChipColorClass(directiveType);
  // ponytail: text + generate directives reference canvas nodes. The
  // chip reads its target id from `directiveId` and calls into the
  // canvas API on click — the canvas's `focusNode` pans to the source
  // AND selects it (so the round-trip back lands the user on the
  // highlighted node, not just the area around it). No-op when the
  // canvas isn't mounted (ready=false → focusNode is a noop).
  const canvas = useCanvas();
  const isCanvasRef = CANVAS_NODE_DIRECTIVES.has(directiveType);
  const interactiveClass = isCanvasRef
    ? `cursor-pointer transition-colors ${getChipHoverClass(directiveType)}`
    : "";
  return (
    <span
      data-directive-id={directiveId}
      data-directive-type={directiveType}
      className={`${DIRECTIVE_CHIP_CLASS} ${colorClass} ${interactiveClass}`}
      onClick={isCanvasRef && directiveId ? () => canvas.focusNode(directiveId) : undefined}
      role={isCanvasRef ? "button" : undefined}
      tabIndex={isCanvasRef ? 0 : undefined}
      onKeyDown={
        isCanvasRef && directiveId
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                canvas.focusNode(directiveId);
              }
            }
          : undefined
      }
    >
      {Icon ? <Icon className="size-3.5" /> : null}
      <span>{label}</span>
    </span>
  );
}

export function renderDirectiveSegments(
  text: string,
  // ponytail: only used by the composer overlay; in message bubbles
  // (DirectiveText) we always want chips parsed. During IME
  // composition we pass composing=true to skip directive parsing and
  // render the raw buffer verbatim — otherwise the chips flicker as
  // the user types pinyin.
  options?: { composing?: boolean },
): ReactElement[] {
  if (options?.composing) {
    // ponytail: during IME composition, the overlay shows the raw
    // text exactly as the textarea holds it. Any directive parse would
    // flash chips as the user types pinyin. Visually inert during
    // composition; chips re-appear on compositionend.
    return [<span key="ime-buffer">{text}</span>];
  }
  const segments = kbMentionFormatter.parse(text);
  return segments.map((segment, i) => {
    if (segment.kind === "text") {
      // ponytail: preserve whitespace + line breaks verbatim —
      // the composer emits them and the user expects them.
      return <span key={i}>{segment.text}</span>;
    }
    return (
      <DirectiveChipSpan
        key={i}
        directiveType={segment.type}
        label={segment.label}
        directiveId={segment.id}
      />
    );
  });
}
