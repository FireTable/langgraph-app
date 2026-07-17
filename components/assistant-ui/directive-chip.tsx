"use client";

import { FileTextIcon, FolderIcon } from "lucide-react";
import type { ReactElement } from "react";
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

/** Returns the icon component for a given directive type. */
export function getChipIcon(directiveType: DirectiveType) {
  if (directiveType === "kb-folder") return FolderIcon;
  if (directiveType === "kb-document" || directiveType === "kb-doc") return FileTextIcon;
  return null;
}

/** Returns the Tailwind color classes for a given directive type. */
export function getChipColorClass(directiveType: DirectiveType): string {
  if (directiveType === "kb-folder") {
    return "bg-indigo-500/10 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-400 border-indigo-500/20 dark:border-indigo-400/30";
  }
  return "bg-emerald-500/10 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 dark:border-emerald-400/30";
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
  return (
    <span
      data-directive-id={directiveId}
      data-directive-type={directiveType}
      className={`${DIRECTIVE_CHIP_CLASS} ${colorClass}`}
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
