// ponytail: small server-rendered bash code block. A tokenizer
// pass colors commands / flags / strings / URLs / env-vars so the
// Command tab reads like a terminal excerpt without pulling in a
// syntax highlighter. Whitespace is preserved as its own tone so
// tokenization is lossless.

import type { FC } from "react";

import { cn } from "@/lib/utils";

const COMMENT = /^\s*#.*$/;

type Tone = "comment" | "command" | "string" | "url" | "flag" | "envvar" | "plain";

type Token = { text: string; tone: Tone };

function classifyNonComment(piece: string, isFirstWord: boolean): Tone {
  if (/^["'].*["']$/.test(piece)) return "string";
  if (/^https?:\/\//.test(piece)) return "url";
  if (/^-{1,2}\w/.test(piece)) return "flag";
  if (isFirstWord) return "command";
  return "plain";
}

function isEnvVar(piece: string): boolean {
  return /^[A-Z][A-Z0-9_]+$/.test(piece);
}

function tokenize(line: string): Token[] {
  if (COMMENT.test(line)) {
    // Highlight env-var names inside comments (e.g. OPENAI_API_KEY
    // inside `# fill in OPENAI_API_KEY, ...`). The rest of the
    // line stays muted/italic.
    const tokens: Token[] = [];
    for (const piece of line.split(/(\s+)/)) {
      if (!piece) continue;
      tokens.push({
        text: piece,
        tone: isEnvVar(piece) ? "envvar" : "comment",
      });
    }
    return tokens;
  }
  // Non-comment: first non-whitespace token is the command, then
  // flags / URLs / strings get their own tones, everything else is
  // plain. Splits preserve whitespace so the rendered output is
  // byte-identical to the source line.
  const tokens: Token[] = [];
  let firstWordSeen = false;
  for (const piece of line.split(/(\s+)/)) {
    if (!piece) continue;
    if (/^\s+$/.test(piece)) {
      tokens.push({ text: piece, tone: "plain" });
      continue;
    }
    const isFirst = !firstWordSeen;
    firstWordSeen = true;
    tokens.push({ text: piece, tone: classifyNonComment(piece, isFirst) });
  }
  return tokens;
}

const TONE_CLASS: Record<Tone, string> = {
  comment: "text-muted-foreground italic",
  command: "text-violet-600 dark:text-violet-400",
  string: "text-emerald-600 dark:text-emerald-400",
  url: "text-emerald-600 dark:text-emerald-400",
  flag: "text-amber-600 dark:text-amber-400",
  envvar: "text-sky-600 dark:text-sky-400",
  plain: "",
};

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
    {code.split("\n").map((line, i) => (
      <div key={i}>
        {tokenize(line).map((t, j) => (
          <span key={j} className={cn(TONE_CLASS[t.tone])}>
            {t.text}
          </span>
        ))}
        {"\n"}
      </div>
    ))}
  </pre>
);
