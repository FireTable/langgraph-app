"use client";

// ponytail: card shell + header primitives used by every tool-ui card.
// Keep the API tight — the only knobs the cards actually vary are the
// max width, the icon-wrap color, and (rarely) the shell background. If
// a card needs a 3rd knob, the right answer is usually a new prop here,
// not another inline copy in the card file.

import type { FC, ReactNode } from "react";

import { cn } from "@/lib/utils";

const CARD_SHELL =
  "border-border/60 bg-card text-card-foreground overflow-hidden rounded-xl border";
const CARD_INNER = "flex flex-col gap-3 p-4";
const ICON_WRAP = "flex size-9 shrink-0 items-center justify-center rounded-full";

export type CardShellProps = {
  /** Set on the outer wrapper so DOM probes (`[data-slot="..."]`) can target the card. */
  "data-slot"?: string;
  /** Max width — most cards use `max-w-2xl`; the connect-wallet modal uses `max-w-md`. */
  maxWidthClass?: string;
  className?: string;
  children: ReactNode;
};

export const CardShell: FC<CardShellProps> = ({
  "data-slot": dataSlot,
  maxWidthClass = "max-w-2xl",
  className,
  children,
}) => (
  <div data-slot={dataSlot} className={cn(CARD_SHELL, maxWidthClass, className)}>
    <div className={CARD_INNER}>{children}</div>
  </div>
);

export type CardHeaderProps = {
  icon: ReactNode;
  /** Background + text color pair for the icon circle. Default uses primary tint. */
  iconClassName?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned content (e.g. a share button, a status badge). */
  trailing?: ReactNode;
};

export const CardHeader: FC<CardHeaderProps> = ({
  icon,
  iconClassName = "bg-primary/10 text-primary",
  title,
  subtitle,
  trailing,
}) => (
  <header className="flex items-center gap-3">
    <div className={cn(ICON_WRAP, iconClassName)}>{icon}</div>
    <div className="min-w-0 flex-1">
      <p className="text-sm font-medium">{title}</p>
      {subtitle != null && <p className="text-muted-foreground mt-0.5 text-xs">{subtitle}</p>}
    </div>
    {trailing}
  </header>
);
