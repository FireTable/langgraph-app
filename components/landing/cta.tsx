import Link from "next/link";
import type { FC } from "react";
import { ArrowRightIcon, ExternalLinkIcon, MessagesSquareIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

export type CtaProps = {
  signedIn: boolean | null;
};

export const Cta: FC<CtaProps> = ({ signedIn }) => {
  const isAuthed = signedIn === true;
  const ctaHref = isAuthed ? "/chat" : "/login";
  const ctaLabel = isAuthed ? "Chat now" : "Sign in";
  // ponytail: chat glyph for the chat destination, generic arrow
  // for the login screen (which isn't itself a named surface).
  const CtaIcon = isAuthed ? MessagesSquareIcon : ArrowRightIcon;
  return (
    // ponytail: warm conic gradient + heavy blur sits behind the
    // card. Same palette as the interrupt-glow ring
    // (var(--glow-warm) / var(--glow-bright) in globals.css) so
    // the "interrupt" affordance and the "ship it" affordance
    // share a hue family — the page reads as one design.
    <section id="cta" className="border-b border-border/60 relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 blur-3xl"
        style={{
          background:
            "conic-gradient(from 180deg at 50% 50%, var(--glow-warm) 0deg, var(--glow-bright) 120deg, var(--glow-warm) 240deg, var(--glow-bright) 360deg)",
          opacity: 0.35,
        }}
      />
      <div className="mx-auto w-full max-w-6xl px-6 py-24">
        <div className="bg-card/70 supports-[backdrop-filter]:bg-card/50 supports-[backdrop-filter]:backdrop-blur-md border-border/60 flex flex-col items-start gap-6 rounded-2xl border p-8 sm:p-10">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Read the code. Run it. Skip the demo.
          </h2>
          <p className="text-muted-foreground max-w-2xl text-base leading-relaxed">
            The repo is the documentation. README for the tour, docs/ for the design notes, the
            source for everything else. If something is unclear, open an issue — issues are answered
            in public.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild size="lg">
              <Link href={ctaHref}>
                <CtaIcon />
                {ctaLabel}
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <a
                href="https://github.com/FireTable/langgraph-app"
                target="_blank"
                rel="noreferrer noopener"
              >
                <ExternalLinkIcon />
                View on GitHub
              </a>
            </Button>
            <Button asChild size="lg" variant="ghost">
              <Link href="#how-it-works">Re-read the explainers</Link>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
};
