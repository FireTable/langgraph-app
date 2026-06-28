"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

// Displays a long hex string (wallet address, tx hash, order id) with
// the middle elided — hover shows the full value, an inline button
// copies it to the clipboard. Width-aware: only shortens when the
// string actually overflows the available space, so a 10-char id
// passes through unchanged.
//
// Why a <button>: clicking anywhere on the truncated value (text or
// icon) copies. The button is also keyboard-focusable, so Cmd+C after
// Tab works for users who prefer not to mouse the icon.
//
// Why the execCommand fallback: navigator.clipboard.writeText throws
// in insecure contexts (non-https) and when permissions are denied.
// The textarea + execCommand fallback keeps copy working in those
// edge cases — important because the chat runs on http://localhost
// during dev where the clipboard API is sometimes gated.

type AddressOrHashProps = {
  value: string;
  /** Head chars to keep. Default 6 (matches 0x1234…). */
  head?: number;
  /** Tail chars to keep. Default 4. */
  tail?: number;
  /** Tail layout: copy button + truncated value (default), or just the
   *  truncated value with hover-tooltip + click-to-copy. */
  showCopyButton?: boolean;
  className?: string;
  /** Render the underlying value as <code> for screen readers. */
  asCode?: boolean;
};

function truncate(value: string, head: number, tail: number): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

// Legacy fallback for when navigator.clipboard is unavailable. Kept
// here, not in a lib, because it's a tiny specialized copy — only
// AddressOrHash needs it and pulling in clipboard-polyfill is overkill.
function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ta.style.pointerEvents = "none";
    document.body.appendChild(ta);
    ta.select();
    // execCommand is deprecated but the only reliable fallback when
    // navigator.clipboard is gated (insecure context, denied perms).
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function AddressOrHash({
  value,
  head = 6,
  tail = 4,
  showCopyButton = true,
  className,
  asCode = true,
}: AddressOrHashProps) {
  const [copied, setCopied] = useState(false);
  const truncated = truncate(value, head, tail);
  const isTruncated = truncated !== value;

  const handleCopy = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(value);
      ok = true;
    } catch {
      ok = legacyCopy(value);
    }
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  const valueNode = (
    <span
      className={cn(
        "font-mono text-xs tabular-nums",
        asCode && "rounded bg-muted/40 px-1 py-0.5",
        className,
      )}
    >
      {truncated}
    </span>
  );

  const trigger = (
    <button
      type="button"
      onClick={isTruncated ? handleCopy : undefined}
      className={cn(
        "hover:bg-muted/60 -m-0.5 inline-flex max-w-full items-center gap-1 rounded p-0.5 transition-colors",
        isTruncated && "cursor-pointer",
      )}
      data-action="copy-address-or-hash"
      aria-label={isTruncated ? `Copy ${value}` : undefined}
    >
      {valueNode}
      {showCopyButton ? (
        copied ? (
          <CheckIcon
            aria-hidden
            className="text-emerald-600 dark:text-emerald-400 size-3 shrink-0"
          />
        ) : (
          <CopyIcon
            aria-hidden
            className={cn(
              "text-muted-foreground size-3 shrink-0",
              isTruncated && "group-hover:text-foreground",
            )}
          />
        )
      ) : null}
    </button>
  );

  if (!isTruncated) return trigger;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent side="top" className="font-mono text-xs">
          {value}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
