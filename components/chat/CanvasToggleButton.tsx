"use client";

import { LayoutPanelLeft } from "lucide-react";
import type { FC } from "react";

import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { cn } from "@/lib/utils";

// ponytail: canvas toggle. Hidden on mobile (< md) — at <768px we
// collapse to chat-only and the user can still paste images via the
// existing attachment composer.
//
// `LayoutPanelLeft` glyph chosen to mirror the header's sidebar
// `PanelLeftIcon` — the two toggles read as siblings (one for the
// thread list, one for the canvas panel). Size 7 (vs the sidebar's
// 8) keeps it visually lighter since the canvas toggle only appears
// on desktop and shouldn't compete with the brand mark / thread
// title. Active state = secondary variant (bg tint) — the icon
// stays the same so it reads as "canvas toggle", not "close".

type Props = {
  open: boolean;
  // ponytail: renamed per the "use client" rule that props from
  // server → client must look like Server Actions.
  onToggleAction: () => void;
  // ponytail: parent can pass extra classes (e.g. `ml-auto` to push
  // the toggle to the right edge of the header).
  className?: string;
};

export const CanvasToggleButton: FC<Props> = ({ open, onToggleAction, className }) => (
  <TooltipIconButton
    variant={open ? "secondary" : "ghost"}
    size="icon"
    tooltip={open ? "Close Canvas" : "Open Canvas"}
    side="bottom"
    onClick={onToggleAction}
    className={cn("hidden size-7 md:flex", className)}
    data-testid="canvas-toggle"
  >
    <LayoutPanelLeft className="size-3.5" />
  </TooltipIconButton>
);
