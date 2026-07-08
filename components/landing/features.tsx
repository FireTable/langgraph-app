import type { FC, ReactNode } from "react";
import {
  MessagesSquareIcon,
  GitBranchIcon,
  BrainIcon,
  ActivityIcon,
  WrenchIcon,
  ServerIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

// ponytail: feature grid is fully server-rendered. The icons come from
// lucide; no per-card motion needed at the section level — the
// how-it-works section carries the load for "show, don't tell".

type Feature = {
  title: string;
  description: string;
  icon: ReactNode;
  iconClassName: string;
};

const FEATURES: Feature[] = [
  {
    title: "Streaming chat",
    description:
      "Tokens flow from LangGraph to the UI in real time. The runtime never blocks waiting for a complete response.",
    icon: <MessagesSquareIcon className="size-4" />,
    iconClassName: "bg-primary/10 text-primary",
  },
  {
    title: "Dual-graph agent",
    description:
      "A chat graph routes to sub-agents; a second background graph handles summarization and observability after every turn.",
    icon: <GitBranchIcon className="size-4" />,
    iconClassName: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  {
    title: "Cross-conversation memory",
    description:
      "User facts and recent threads are surfaced automatically. The model sees them; you don't manage them.",
    icon: <BrainIcon className="size-4" />,
    iconClassName: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  },
  {
    title: "Observability waterfall",
    description:
      "Every LLM call, tool run, and graph node is captured as a span tree. Inspect the per-turn path that produced any reply.",
    icon: <ActivityIcon className="size-4" />,
    iconClassName: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  {
    title: "Composable tools",
    description:
      "Web search, code execution, NFT holdings, on-chain prices, weather — all lazy-registered so missing keys never 401.",
    icon: <WrenchIcon className="size-4" />,
    iconClassName: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  },
  {
    title: "Self-host first",
    description:
      "One docker-compose, one Postgres, one process. No SaaS, no per-seat pricing, no tracking pixels.",
    icon: <ServerIcon className="size-4" />,
    iconClassName: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  },
];

export const Features: FC = () => (
  <section id="features" className="border-b border-border/60">
    <div className="mx-auto w-full max-w-6xl px-6 py-24">
      <div className="mb-12 flex flex-col gap-3">
        <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Everything the chat needs, nothing it doesn't.
        </h2>
        <p className="text-muted-foreground max-w-2xl text-base">
          The project ships the parts of an LLM product that you would otherwise rebuild every time.
          Each is small, observable, and swappable.
        </p>
      </div>

      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((feature) => (
          <li
            key={feature.title}
            className={cn(
              "border-border/60 bg-card text-card-foreground flex flex-col gap-3 rounded-xl border p-5",
              "transition-colors hover:border-border",
            )}
          >
            <div
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-full",
                feature.iconClassName,
              )}
            >
              {feature.icon}
            </div>
            <h3 className="text-base font-semibold">{feature.title}</h3>
            <p className="text-muted-foreground text-sm leading-relaxed">{feature.description}</p>
          </li>
        ))}
      </ul>
    </div>
  </section>
);
