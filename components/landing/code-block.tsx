// ponytail: small server-rendered bash code block. Renders
// monospace text with a tiny token-color pass (comment / string /
// command) so the Agent tab reads like a real terminal excerpt
// without pulling in a syntax highlighter.

import type { FC } from "react";

import { cn } from "@/lib/utils";

const COMMENT = /^\s*#.*$/;

type Token = { text: string; tone: "comment" | "string" | "plain" };

function tokenize(line: string): Token[] {
  if (COMMENT.test(line)) return [{ text: line, tone: "comment" }];
  // Split on quoted strings; render the rest as plain.
  const out: Token[] = [];
  const re = /"[^"]*"|'[^']*'/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) out.push({ text: line.slice(last, m.index), tone: "plain" });
    out.push({ text: m[0], tone: "string" });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ text: line.slice(last), tone: "plain" });
  return out;
}

export type CodeBlockProps = {
  code: string;
  className?: string;
};

export const CodeBlock: FC<CodeBlockProps> = ({ code, className }) => (
  <pre
    className={cn(
      "border-border/60 bg-muted/40 text-foreground/90 overflow-x-auto rounded-lg border p-3 font-mono text-[11px] leading-relaxed",
      className,
    )}
  >
    {code.split("\n").map((line, i) => {
      const tokens = tokenize(line);
      return (
        <div key={i}>
          {tokens.map((t, j) => (
            <span
              key={j}
              className={cn(
                t.tone === "comment" && "text-muted-foreground italic",
                t.tone === "string" && "text-emerald-600 dark:text-emerald-400",
              )}
            >
              {t.text}
            </span>
          ))}
          {"\n"}
        </div>
      );
    })}
  </pre>
);
