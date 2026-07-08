"use client";

// ponytail: memory block reveal. Shows a fake system prompt
// appearing above a fake user prompt — the visual story is "the
// model now has context it didn't have before". `useInView` triggers
// the reveal when the section enters the viewport.

import { m, useInView, useReducedMotion } from "motion/react";
import { useRef } from "react";

const MEMORY_FACTS = [
  "User prefers TypeScript over JavaScript",
  "Working on a self-hosted LangGraph chat project",
  "Time zone: UTC+8",
];

const RECENT_THREADS = [
  "Today · LangGraph checkpoint migration",
  "Yesterday · Drizzle + Better Auth setup",
  "Last week · Tailwind v4 theme tokens",
];

export const MemoryRecallDemo = () => {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });
  const visible = reduced || inView;

  return (
    <div ref={ref} className="bg-background flex w-full max-w flex-col gap-3 rounded-xl p-4">
      <Block label="system" delay={0} visible={visible}>
        <p className="text-foreground/90 mb-1.5 text-[11px] font-medium tracking-wide uppercase">
          Memory
        </p>
        <ul className="flex flex-col gap-1">
          {MEMORY_FACTS.map((fact) => (
            <li key={fact} className="text-foreground/90 text-xs">
              · {fact}
            </li>
          ))}
        </ul>
      </Block>
      <Block label="threads" delay={0.15} visible={visible}>
        <p className="text-foreground/90 mb-1.5 text-[11px] font-medium tracking-wide uppercase">
          Recent threads
        </p>
        <ul className="flex flex-col gap-1">
          {RECENT_THREADS.map((thread) => (
            <li key={thread} className="text-muted-foreground text-xs">
              · {thread}
            </li>
          ))}
        </ul>
      </Block>
      <Block label="user" delay={0.3} visible={visible} highlight>
        <p className="text-xs">What did I do with Tailwind last week?</p>
      </Block>
    </div>
  );
};

type BlockProps = {
  label: string;
  delay: number;
  visible: boolean;
  highlight?: boolean;
  children: React.ReactNode;
};

const Block = ({ label, delay, visible, highlight, children }: BlockProps) => (
  <m.div
    initial={{ opacity: 0, y: 6 }}
    animate={visible ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 }}
    transition={{ duration: 0.35, ease: "easeOut", delay }}
    className={
      "rounded-lg border p-3 " +
      (highlight ? "border-border bg-primary/5" : "border-border/60 bg-muted/30")
    }
  >
    <p className="text-muted-foreground mb-1.5 text-[10px] font-mono tracking-wide uppercase">
      {label}
    </p>
    {children}
  </m.div>
);
