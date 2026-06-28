"use client";

// ponytail: shared code-block chrome for tool-ui cards. Reuses the
// markdown CodeHeader (language label + copy button) and the project's
// SyntaxHighlighter (prism-react-renderer, github/vsDark by theme) from
// the chat markdown primitive, so fenced code in a chat message and a
// code card look identical — same colors, same chrome.

import { CodeHeader } from "@/components/assistant-ui/markdown-text";
import { SyntaxHighlighter } from "@/components/assistant-ui/syntax-highlighter";
import { cn } from "@/lib/utils";

export function CodeBlock({
  language,
  code,
  className,
  header = true,
  label,
}: {
  language: string;
  code: string;
  className?: string;
  /** Show the header bar (label + copy button). Default true. Set false for a plain pre without chrome. */
  header?: boolean;
  /** Override the header label (defaults to `language`). Useful for output blocks like "Result" / "Stdout" / "Stderr". */
  label?: string;
}) {
  return (
    <div className={cn("aui-md-codeblock", className)}>
      {header && <CodeHeader language={label ?? language} code={code} className="mt-0" />}
      <SyntaxHighlighter code={code} language={language} standalone={!header} />
    </div>
  );
}
