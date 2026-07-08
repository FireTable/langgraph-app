// ponytail: hero is server-rendered. The motion preview lives in a
// client island (StreamingPreview) so the page never blocks first
// paint on the framer bundle. Header is rendered separately by the
// route layout, so this section is just the pitch + preview.

import type { FC } from "react";

import { APP_NAME } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { HeroCta } from "@/components/landing/hero-cta";
import { StreamingPreview } from "@/components/landing/motion/streaming-preview";

export type HeroProps = {
  signedIn: boolean | null;
};

export const Hero: FC<HeroProps> = ({ signedIn }) => (
  <section className="relative isolate overflow-hidden border-b border-border/60">
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-16 px-6 pt-16 pb-24 lg:flex-row lg:items-center lg:gap-16 lg:pt-24">
      <div className="flex flex-1 flex-col gap-8">
        <p className="text-muted-foreground w-fit rounded-full border border-border/60 bg-muted/30 px-3 py-1 text-xs font-medium tracking-wide uppercase">
          Self-hostable · Open source
        </p>

        <h1 className="text-5xl leading-[1.05] font-semibold tracking-tight sm:text-6xl lg:text-7xl">
          {/* ponytail: flowing warm-halo gradient on the h1.
              - halo span sits behind the text, blurred, so the
                surrounding whitespace picks up a soft rose/amber
                wash.
              - text span clips the same gradient to the glyphs and
                drifts position via the `alternate` keyframe so the
                colors oscillate rather than snap.
              Both run on the same 6s clock so the wash and the
              glyphs stay in phase. */}
          <span className="relative inline-block">
            <span
              aria-hidden
              className={cn(
                "absolute -inset-x-2 inset-y-1 -z-10 rounded-[inherit] blur-2xl opacity-60",
                "bg-gradient-to-r from-rose-500 via-amber-500 to-amber-300",
                "dark:from-rose-400 dark:via-amber-400 dark:to-amber-200",
                "animate-hero-halo-flow",
              )}
            />
            <span
              className={cn(
                "bg-clip-text text-transparent",
                "bg-gradient-to-r from-rose-500 via-amber-500 to-amber-300",
                "dark:from-rose-400 dark:via-amber-400 dark:to-amber-200",
                "animate-hero-text-flow",
              )}
            >
              {APP_NAME}
            </span>
          </span>
          <br />
          <span className="text-muted-foreground text-3xl leading-[1.05]">
            A chat surface for a real agent graph.
          </span>
        </h1>

        <p className="text-muted-foreground max-w-xl text-base leading-relaxed sm:text-lg">
          Streaming chat backed by a LangGraph StateGraph. A second graph quietly runs memory
          summarization, observability capture, and thread housekeeping after every turn. Ship the
          whole thing on a single VPS.
        </p>

        <HeroCta signedIn={signedIn} showSecondary />
      </div>

      <div className="flex flex-1 items-center justify-center lg:justify-end">
        <StreamingPreview />
      </div>
    </div>
  </section>
);
