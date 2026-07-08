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

        <h1 className="text-4xl leading-[1.05] font-semibold tracking-tight sm:text-5xl lg:text-6xl">
          <span
            className={cn(
              "bg-clip-text text-transparent",
              "bg-gradient-to-r from-violet-600 via-rose-500 to-amber-500",
              "dark:from-violet-400 dark:via-rose-400 dark:to-amber-400",
            )}
          >
            {APP_NAME}
          </span>
          <br />
          <span className="text-muted-foreground">A chat surface for a real agent graph.</span>
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
