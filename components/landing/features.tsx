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
  hue: HueKey;
  span: "big" | "wide" | "default";
  codePreview?: string; // ponytail: optional monospace snippet rendered below the description; used by Chat anything to fill the 2x2 with a non-text visual
};

// ponytail: liquid-glass chip — translucent hue fill + backdrop blur
// + inset ring + a soft white inner highlight so the chip reads as
// a tinted lens, not a flat circle. The bento already had flat
// tinted backgrounds; this upgrade gives each icon a distinct
// surface that pops without competing with the headliner card's
// amber wash. Per-card hue lives in the `hue` field (key into HUE);
// `bg-{color}/25 text-{color}`; the rest of the glass chrome is
// shared.
const GLASS_CHIP =
  "backdrop-blur-md ring-1 ring-inset ring-white/40 shadow-[inset_0_1px_1px_rgba(255,255,255,0.5)] dark:ring-white/10 dark:shadow-[inset_0_1px_1px_rgba(255,255,255,0.08)]";

// ponytail: palette of bento hues. Each entry pairs an icon-chip
// class (translucent fill + dark-mode text) with a card-level
// background tint + matching border. The bento needs each card
// to feel distinct without two adjacent cards landing in the same
// family (sky+teal, rose+fuchsia, amber+orange all read as
// duplicates). 10 entries is room for a 7-card bento + 3-card row
// with one repeat maximum; expand the list before duplicating.
//
// `chip` paints the icon circle; `card` paints the card body
// (bg-{color}/10 with hue-matching border). Tinting the whole
// card (not just the chip) is what makes the bento read as a
// bento — each card wears its own colour, not just an accent dot.
type HueEntry = { chip: string; card: string };
const HUE: Record<string, HueEntry> = {
  amber: {
    chip: "bg-amber-500/25 text-amber-700 dark:text-amber-300",
    card: "bg-amber-50 border-amber-200/60 dark:bg-amber-950/40 dark:border-amber-800/40",
  },
  orange: {
    chip: "bg-orange-500/25 text-orange-700 dark:text-orange-300",
    card: "bg-orange-50 border-orange-200/60 dark:bg-orange-950/40 dark:border-orange-800/40",
  },
  rose: {
    chip: "bg-rose-500/25 text-rose-700 dark:text-rose-300",
    card: "bg-rose-50 border-rose-200/60 dark:bg-rose-950/40 dark:border-rose-800/40",
  },
  fuchsia: {
    chip: "bg-fuchsia-500/25 text-fuchsia-700 dark:text-fuchsia-300",
    card: "bg-fuchsia-50 border-fuchsia-200/60 dark:bg-fuchsia-950/40 dark:border-fuchsia-800/40",
  },
  violet: {
    chip: "bg-violet-500/25 text-violet-700 dark:text-violet-300",
    card: "bg-violet-50 border-violet-200/60 dark:bg-violet-950/40 dark:border-violet-800/40",
  },
  indigo: {
    chip: "bg-indigo-500/25 text-indigo-700 dark:text-indigo-300",
    card: "bg-indigo-50 border-indigo-200/60 dark:bg-indigo-950/40 dark:border-indigo-800/40",
  },
  sky: {
    chip: "bg-sky-500/25 text-sky-700 dark:text-sky-300",
    card: "bg-sky-50 border-sky-200/60 dark:bg-sky-950/40 dark:border-sky-800/40",
  },
  teal: {
    chip: "bg-teal-500/25 text-teal-700 dark:text-teal-300",
    card: "bg-teal-50 border-teal-200/60 dark:bg-teal-950/40 dark:border-teal-800/40",
  },
  emerald: {
    chip: "bg-emerald-500/25 text-emerald-700 dark:text-emerald-300",
    card: "bg-emerald-50 border-emerald-200/60 dark:bg-emerald-950/40 dark:border-emerald-800/40",
  },
  lime: {
    chip: "bg-lime-500/25 text-lime-700 dark:text-lime-300",
    card: "bg-lime-50 border-lime-200/60 dark:bg-lime-950/40 dark:border-lime-800/40",
  },
};
type HueKey = keyof typeof HUE;

const BENTO: BentoCard[] = [
  {
    title: "Chat anything",
    description:
      "Ask the model about anything — web lookups, code reviews, prices, weather, even trade approvals. Tokens reach the chat live, the moment the model emits.\nMarkdown, code blocks, and tool-call UI render inline on the same wire.\nA click stops the reply mid-flight — the SDK cancels, nothing half-written persists.",
    icon: <MessagesSquareIcon className="size-6" />,
    hue: "rose",
    span: "big",
    codePreview: ``,
  },
  {
    title: "Memory + Knowledge Base",
    description:
      "User facts surface in the system block; PDFs, images, plain text, markdown, and Office Open XML (DOCX / XLSX / PPTX) — plus pasted URLs fetched server-side — all go through a per-doc pipeline (OCR or structured parse → chunk → embed → entity) and become a hybrid-searchable index. Both are reviewable and deletable from settings.",
    icon: <BrainIcon className="size-4" />,
    hue: "violet",
    span: "wide",
  },
  {
    title: "Dual-graph agent",
    description:
      "Chat handles the turn; a second graph runs memory, summarization, and observability capture behind the scenes.",
    icon: <GitBranchIcon className="size-4" />,
    hue: "emerald",
    span: "default",
  },
  {
    title: "Observability waterfall",
    description:
      "Every span, every tool — one tree. Redacted at write, indexed by turn, viewable alongside the reply.",
    icon: <ActivityIcon className="size-4" />,
    hue: "indigo",
    span: "default",
  },
];

type RowCard = {
  title: string;
  description: string;
  icon: ReactNode;
  hue: HueKey;
};

const BOTTOM_ROW: RowCard[] = [
  {
    title: "Composable tools",
    description: "Web, code, NFT, prices, weather — lazy-registered so missing keys never 401.",
    icon: <WrenchIcon className="size-4" />,
    hue: "fuchsia",
  },
  {
    title: "Human in the loop",
    description:
      "LangGraph's interrupt() pauses the run for the user — locations, wallets, trade confirmations.",
    icon: <UserCheckIcon className="size-4" />,
    hue: "orange",
  },
  {
    title: "Self-host first",
    description:
      "One docker-compose, one Postgres, one repo. No SaaS, no per-seat pricing, no tracking pixels.",
    icon: <ServerIcon className="size-4" />,
    hue: "sky",
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
        "text-card-foreground flex flex-col gap-3 rounded-2xl border p-5 transition-colors",
        HUE[card.hue].card,
        card.span === "big" && "gap-4 p-6 lg:min-h-[260px]",
        card.span === "wide" && "gap-3 p-6 lg:min-h-[140px]",
        layout[card.span],
      )}
    >
      <div
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full",
          GLASS_CHIP,
          card.span === "big" ? "size-12" : "size-9",
          HUE[card.hue].chip,
        )}
      >
        {card.icon}
      </div>
      {/* ponytail: wide card now renders the same vertical chrome
          as the default cards — icon top-left, title and description
          stacked below. The extra horizontal space lets the long
          Memory title fit on one line without the old horizontal
          flex crushing it into a 3-line wrap. */}
      <div className="flex flex-col gap-2">
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
            "whitespace-pre-line", // ponytail: only the Streaming description uses \n\n for paragraph breaks; other cards are single sentences and unaffected
          )}
        >
          {card.description}
        </p>
        {card.codePreview && (
          <pre className="bg-muted/40 border-border/40 text-foreground/85 mt-1 overflow-x-auto rounded-md border p-3 font-mono text-[11px] leading-relaxed">
            <code>{card.codePreview}</code>
          </pre>
        )}
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
        <div className="grid grid-cols-1 gap-4 lg:auto-rows-fr lg:grid-cols-4">
          {BENTO.map((card, i) => (
            <BentoShell key={card.title} card={card}>
              {i === 0 && <StreamingHint />}
            </BentoShell>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {BOTTOM_ROW.map((card) => (
            <div
              key={card.title}
              className={cn(
                "text-card-foreground flex min-h-[180px] flex-col gap-3 rounded-2xl border p-6 transition-colors",
                HUE[card.hue].card,
              )}
            >
              <div
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-full",
                  GLASS_CHIP,
                  HUE[card.hue].chip,
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
