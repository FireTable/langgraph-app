import type { FC } from "react";
import { CheckIcon } from "lucide-react";

import { QuickStartTabs } from "@/components/landing/quick-start-tabs";
import { AgentTab } from "@/components/landing/agent-tab";
import { CommandTab } from "@/components/landing/command-tab";

const SHIPPED = [
  "Next.js frontend (App Router, RSC, route groups)",
  "LangGraph dev server (`:2024`) with Postgres checkpointer",
  "Drizzle migrations + Better Auth email + OAuth",
  "OpenAI-compatible chat model — bring your own key",
  "Observability collector + retention cron",
];

export const SelfHost: FC = () => (
  <section id="self-host" className="border-b border-border/60">
    <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-12 px-6 py-24 lg:grid-cols-2">
      <div className="flex flex-col gap-6">
        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Self-host
        </p>
        <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          One VPS. One Postgres. One process.
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed">
          The project is built to run on a single box. No SaaS, no per-seat pricing, no background
          services talking to a third party. Bring your own OpenAI-compatible endpoint and your own
          Postgres; the rest is in the repo.
        </p>
        <ul className="flex flex-col gap-3">
          {SHIPPED.map((item) => (
            <li key={item} className="flex items-start gap-3 text-sm">
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                <CheckIcon className="size-3" />
              </span>
              <span className="text-foreground/90">{item}</span>
            </li>
          ))}
        </ul>
      </div>

      <QuickStartTabs agent={<AgentTab />} command={<CommandTab />} />
    </div>
  </section>
);
