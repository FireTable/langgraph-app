"use client";

// ponytail: auth-aware CTA. Server page reads the session and
// passes a boolean; this stays a tiny client component so the
// marketing copy renders identically in unit tests (no DB / no
// next/headers mocks). `null` falls through to the signed-out copy
// so the first paint is never an empty button during the server-side
// session lookup.
//
// `compact` swaps the primary for a single default-size button
// (used in the header). `iconOnly` strips the label entirely for
// narrow mobile widths. The hero ignores both — it always renders
// the full primary + secondary pair via its own composition.

import Link from "next/link";
import { ArrowRightIcon, MessagesSquareIcon } from "lucide-react";
import type { FC } from "react";

import { Button } from "@/components/ui/button";

export type HeroCtaProps = {
  signedIn: boolean | null;
  compact?: boolean;
  iconOnly?: boolean;
  showSecondary?: boolean;
};

export const HeroCta: FC<HeroCtaProps> = ({
  signedIn,
  compact = false,
  iconOnly = false,
  showSecondary = false,
}) => {
  const isAuthed = signedIn === true;
  const href = isAuthed ? "/chat" : "/login";
  // ponytail: icon is a destination glyph, not a generic arrow.
  // Chat now = chat bubble (the destination is the chat surface);
  // Sign in keeps the arrow since /login is not itself a named
  // destination.
  const label = isAuthed ? "Chat now" : "Sign in";
  const Icon = isAuthed ? MessagesSquareIcon : ArrowRightIcon;

  if (iconOnly) {
    return (
      <Button asChild size="icon" variant="outline" aria-label={label}>
        <Link href={href}>
          <Icon />
        </Link>
      </Button>
    );
  }

  if (compact) {
    return (
      <Button asChild size="sm">
        <Link href={href}>
          <Icon />
          {label}
        </Link>
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button asChild size="lg">
        <Link href={href}>
          <Icon />
          {label}
        </Link>
      </Button>
      {showSecondary && (
        <Button asChild size="lg" variant="ghost">
          <Link href="#how-it-works">See how it works</Link>
        </Button>
      )}
    </div>
  );
};
