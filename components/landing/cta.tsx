import Link from "next/link";
import type { FC } from "react";
import { ExternalLinkIcon, MessagesSquareIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

export type CtaProps = {
  signedIn: boolean | null;
};

export const Cta: FC<CtaProps> = ({ signedIn }) => {
  const ctaHref = signedIn === true ? "/chat" : "/login";
  // ponytail: copy stays "Chat now" for everyone; only the
  // destination shifts (authed → /chat, anon → /login bounce).
  const ctaLabel = "Chat now";
  const CtaIcon = MessagesSquareIcon;
  return (
    // ponytail: warm halo sits behind the card. Layered so the
    // page bg (white) can't hide it (`-z-10` would punch through
    // to the body — see `relative z-10` on the content wrapper).
    // Same palette as the interrupt-glow ring
    // (var(--glow-warm) / var(--glow-bright) in globals.css) so
    // the "interrupt" affordance and the "ship it" affordance
    // share a hue family — the page reads as one design. The
    // conic is doubled with a radial so the center stays warm
    // even after blur-3xl smears the angular bands. The conic's
    // `from` angle rotates via `cta-marquee` (see globals.css) so
    // the warm overflow breathes instead of standing still. The
    // radial stays put to anchor the layout.
    <section id="cta" className="border-b border-border/60 relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0 blur-3xl"
        style={{
          background:
            "radial-gradient(ellipse 55% 70% at 50% 60%, oklch(0.78 0.2 25 / 0.55) 0%, oklch(0.96 0.08 70 / 0.35) 40%, transparent 75%), conic-gradient(from var(--cta-angle) at 50% 50%, transparent 0deg, var(--glow-warm) 60deg, transparent 140deg, var(--glow-bright) 220deg, transparent 300deg, var(--glow-warm) 360deg)",
          opacity: 0.7,
          animation: "cta-marquee 15s linear infinite",
        }}
      />
      <div className="relative z-10 mx-auto w-full max-w-6xl px-6 py-24">
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
