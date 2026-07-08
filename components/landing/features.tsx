// ponytail: feature bento. Two grids stacked — top is the 4-card
// bento (Streaming big, Memory tall, plus two single cells filling
// the right column) and bottom is a 3-col row of equal-width cards
// (Composable / Human in the loop / Self-host). Two grids feels
// heavier than one but reads cleanly: the bento is the engine,
// the row below are the operational guarantees.

import type { FC, ReactNode } from "react";
import {
  ActivityIcon,
  BrainIcon,
  GitBranchIcon,
  MessagesSquareIcon,
  ServerIcon,
  UserCheckIcon,
  WrenchIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

// ponytail: bottom row sits in its own grid so 3 cards get exactly
// 1/3 width regardless of viewport. The bento above stays
// 4-col so the headliner card can claim its 2×2 footprint.

type BentoCard = {
  title: string;
  description: string;
  icon: ReactNode;
  iconClassName: string;
  span: "big" | "wide" | "default";
};

const BENTO: BentoCard[] = [
  {
    title: "Cross-conversation memory",
    description:
      "User facts and recent threads surface automatically. The model sees them; you don't manage a memory panel — it just remembers.",
    icon: <BrainIcon className="size-6" />,
    iconClassName: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    span: "big",
  },
  {
    title: "Streaming chat",
    description:
      "Tokens flow from LangGraph to the UI in real time. The runtime never blocks waiting for a complete response — aborts cancel at the SDK layer.",
    icon: <MessagesSquareIcon className="size-4" />,
    iconClassName: "bg-primary/10 text-primary",
    span: "wide",
  },
  {
    title: "Dual-graph agent",
    description: "Two graphs in parallel.",
    icon: <GitBranchIcon className="size-4" />,
    iconClassName: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    span: "default",
  },
  {
    title: "Observability waterfall",
    description: "Every span, every tool, one tree.",
    icon: <ActivityIcon className="size-4" />,
    iconClassName: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    span: "default",
  },
];

type RowCard = {
  title: string;
  description: string;
  icon: ReactNode;
  iconClassName: string;
};

const BOTTOM_ROW: RowCard[] = [
  {
    title: "Composable tools",
    description: "Web, code, NFT, prices, weather — lazy-registered so missing keys never 401.",
    icon: <WrenchIcon className="size-4" />,
    iconClassName: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  },
  {
    title: "Human in the loop",
    description:
      "LangGraph's interrupt() pauses the run for the user — locations, wallets, trade confirmations.",
    icon: <UserCheckIcon className="size-4" />,
    iconClassName: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  {
    title: "Self-host first",
    description:
      "One docker-compose, one Postgres, one process. No SaaS, no per-seat pricing, no tracking pixels.",
    icon: <ServerIcon className="size-4" />,
    iconClassName: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  },
];

// ponytail: anchored bottom on the headliner card only. Staggered
// bars evoke "tokens streaming" without re-animating the typewriter
// demo that already lives in the hero above.
const StreamingHint = () => (
  <div className="text-muted-foreground mt-auto flex items-center gap-3 pt-4 text-[11px]">
    <span className="bg-emerald-500 size-2 shrink-0 rounded-full" aria-hidden />
    <span className="font-medium tracking-wide uppercase">Live</span>
    <div className="flex items-center gap-1" aria-hidden>
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <span
          key={i}
          className="bg-foreground/70 inline-block h-1 rounded-full"
          style={{
            width: 4 + ((i * 7) % 12),
            animation: "aui-pulse 1.4s ease-in-out infinite",
            animationDelay: `${i * 0.12}s`,
          }}
        />
      ))}
    </div>
  </div>
);

// ponytail: vertical dot pattern fills the tall Memory card so the
// title isn't floating in dead space.
const MemoryHint = () => (
  <div className="text-muted-foreground mt-auto flex items-end gap-1.5 pt-4">
    {Array.from({ length: 6 }).map((_, i) => (
      <span
        key={i}
        className="bg-violet-500/40 inline-block rounded-sm"
        style={{ width: 6, height: 6 + (i % 3) * 6 }}
        aria-hidden
      />
    ))}
  </div>
);

// ponytail: shared card chrome. The two grids diverge only in
// column-count and row placement; everything inside is uniform so
// the section reads as one design with two regions.
const BentoShell = ({ card, children }: { card: BentoCard; children?: ReactNode }) => {
  // 4-col grid: Memory 2×2 (4 cells) leads; Streaming 2×1 wide
  // spans the top-right half (2 cells); the two single-cell cards
  // stack on the bottom-right column. Streaming drops from headliner
  // to "wide footer" so Memory claims the big footprint.
  const layout: Record<BentoCard["span"], string> = {
    big: "lg:col-span-2 lg:row-span-2",
    wide: "lg:col-span-2 lg:row-span-1",
    default: "lg:col-span-1 lg:row-span-1",
  };
  return (
    <div
      className={cn(
        "border-border/60 bg-card text-card-foreground flex flex-col gap-3 rounded-2xl border p-5 transition-colors hover:border-border",
        card.span === "big" && "gap-4 p-6 min-h-[260px]",
        card.span === "wide" && "gap-3 p-6 min-h-[140px] lg:flex-row lg:items-center lg:gap-6",
        layout[card.span],
      )}
    >
      <div
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full",
          card.span === "big" ? "size-12" : "size-9",
          card.iconClassName,
          card.span === "wide" && "lg:order-first",
        )}
      >
        {card.icon}
      </div>
      {/* ponytail: the wide card lays icon + title + description
          in a row at lg+ so it doesn't read as a "small card
          with empty space" — the headline sits next to the icon,
          the description spills below the row on wider viewports. */}
      <div
        className={cn(
          "flex flex-col gap-2",
          card.span === "wide" && "lg:flex-row lg:items-center lg:gap-4",
        )}
      >
        <h3
          className={cn(
            "font-semibold tracking-tight",
            card.span === "big" ? "text-xl" : "text-base",
          )}
        >
          {card.title}
        </h3>
        <p
          className={cn(
            "text-muted-foreground leading-relaxed",
            card.span === "big" ? "text-sm" : "text-xs",
          )}
        >
          {card.description}
        </p>
      </div>
      {children}
    </div>
  );
};

export const Features: FC = () => (
  <section id="features" className="border-b border-border/60">
    <div className="mx-auto w-full max-w-6xl px-6 py-24">
      <div className="mb-12 flex flex-col gap-3">
        <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Everything the chat needs, nothing it doesn&apos;t.
        </h2>
        <p className="text-muted-foreground max-w-2xl text-base">
          The project ships the parts of an LLM product that you would otherwise rebuild every time.
          Each is small, observable, and swappable.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <div className="grid auto-rows-fr grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          {BENTO.map((card, i) => (
            <BentoShell key={card.title} card={card}>
              {i === 0 && <MemoryHint />}
              {i === 1 && <StreamingHint />}
            </BentoShell>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {BOTTOM_ROW.map((card) => (
            <div
              key={card.title}
              className="border-border/60 bg-card text-card-foreground flex min-h-[180px] flex-col gap-3 rounded-2xl border p-6 transition-colors hover:border-border"
            >
              <div
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-full",
                  card.iconClassName,
                )}
              >
                {card.icon}
              </div>
              <h3 className="text-base font-semibold tracking-tight">{card.title}</h3>
              <p className="text-muted-foreground text-xs leading-relaxed">{card.description}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  </section>
);
