import Link from "next/link";
import type { FC } from "react";
import { ArrowRightIcon, ExternalLinkIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

export type CtaProps = {
  signedIn: boolean | null;
};

export const Cta: FC<CtaProps> = ({ signedIn }) => {
  const isAuthed = signedIn === true;
  const ctaHref = isAuthed ? "/chat" : "/login";
  const ctaLabel = isAuthed ? "Open chat" : "Sign in";
  return (
    <section id="cta" className="border-b border-border/60">
      <div className="mx-auto w-full max-w-6xl px-6 py-24">
        <div className="bg-muted/30 flex flex-col items-start gap-6 rounded-2xl p-8 sm:p-10">
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
                {ctaLabel}
                <ArrowRightIcon />
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
