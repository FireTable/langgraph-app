"use client";

import * as React from "react";
import { CheckIcon, CopyIcon } from "lucide-react";

import { cn } from "@/lib/utils";

// ponytail: shared copy-to-clipboard button used wherever a structured
// payload needs an at-a-glance "grab this JSON" affordance — currently
// the observability panel (per-span fields) and the memory settings
// view (per-row profile fields). Same visual rhythm across both so a
// user who meets it in one place recognizes it in the other. On
// success the icon flips to a check for 1.5s.
export function CopyButton({
  getTextAction,
  label = "Copy",
  className,
}: {
  // ponytail: Next.js's "use client" boundary requires function props
  // to end in `Action` to flag them as client-callable closures.
  getTextAction: () => string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const onClick = () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard.writeText(getTextAction()).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={copied ? "Copied" : label}
      className={cn(
        "text-muted-foreground hover:text-foreground hover:bg-muted/60 inline-flex size-5 items-center justify-center rounded transition-colors",
        className,
      )}
    >
      {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
    </button>
  );
}
