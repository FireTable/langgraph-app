"use client";

// ponytail: Agent tab is a single one-line prompt the visitor
// pastes into their agent chat. The full deploy workflow lives
// in the linked skill file — no need to mirror it on the
// marketing page. "use client" because the CopyButton's
// `getTextAction` prop is a function, and Next.js can't
// serialize function props across the RSC boundary unless the
// receiving component is client.

import { CopyButton } from "@/components/ui/copy-button";
import { SKILL_URL } from "@/components/landing/skill-url";

const PROMPT = `Please help me deploy LangGraph App by following the skill at ${SKILL_URL}.`;

export const AgentTab = () => (
  <div className="border-border/60 bg-card text-card-foreground overflow-hidden rounded-2xl border">
    <div className="border-border/60 flex items-center justify-between border-b px-4 py-2.5">
      <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        Agent prompt
      </span>
      <a
        href={SKILL_URL}
        target="_blank"
        rel="noreferrer noopener"
        className="text-muted-foreground hover:text-foreground text-xs"
      >
        view source ↗
      </a>
    </div>
    <div className="flex flex-col gap-3 p-4">
      <p className="text-muted-foreground text-xs leading-relaxed">
        Paste this into your agent chat (Claude Code, Cursor, etc.). The agent reads the skill and
        walks you through the whole flow — anchors, cold start, daily CD, rollback, backup.
      </p>
      <div className="border-border/60 bg-muted/30 flex items-start gap-3 rounded-lg border p-3">
        <p className="text-foreground/90 flex-1 font-mono text-[11px] leading-relaxed">{PROMPT}</p>
        <CopyButton getTextAction={() => PROMPT} label="Copy prompt" className="shrink-0" />
      </div>
    </div>
  </div>
);
