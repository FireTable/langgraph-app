"use client";

// ponytail: prism-react-renderer slot for both chat markdown and
// tool-ui CodeBlock. Theme flips with next-themes (github / vsDark).
// Background is transparent so the parent's bg-muted/30 shows
// through — the pre below already provides the rounded card chrome.

import { Highlight, themes, type PrismTheme } from "prism-react-renderer";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";

function usePrismTheme(): PrismTheme {
  const { resolvedTheme } = useTheme();
  const base: PrismTheme = resolvedTheme === "dark" ? themes.vsDark : themes.github;
  return { ...base, plain: { ...base.plain, backgroundColor: "transparent" } };
}

export function SyntaxHighlighter({
  code,
  language,
  className,
  standalone = false,
}: {
  code: string;
  language: string;
  className?: string;
  /** When true, render with full rounded corners and a top border (no CodeHeader above). */
  standalone?: boolean;
}) {
  const theme = usePrismTheme();
  // ponytail: tool-ui args stream in over time and may briefly be
  // undefined / a non-string. Coerce before regex — `String.replace`
  // throws on undefined, and prism's Highlight expects strings.
  const safeCode = typeof code === "string" ? code : "";
  const safeLang = typeof language === "string" && language.length > 0 ? language : "text";
  // Source files conventionally end with \n, but that produces a
  // phantom empty line at the bottom of the rendered pre. Strip the
  // trailing newlines before tokenizing so prism renders only real
  // lines.
  const stripped = safeCode.replace(/\n+$/, "");
  return (
    <Highlight code={stripped} language={safeLang} theme={theme}>
      {({ className: cls, style, tokens, getLineProps, getTokenProps }) => (
        <pre
          className={cn(
            cls,
            standalone
              ? "aui-md-pre overflow-x-auto rounded-xl border p-3.5 text-[13px] leading-relaxed"
              : "aui-md-pre overflow-x-auto rounded-t-none rounded-b-xl border border-t-0 p-3.5 text-[13px] leading-relaxed",
            className,
          )}
          style={style}
        >
          {tokens.map((line, i) => {
            const { key: _lineKey, ...lineProps } = getLineProps({ line });
            return (
              <div key={i} {...lineProps}>
                {line.map((token, j) => {
                  const { key: _tokenKey, ...tokenProps } = getTokenProps({ token });
                  return <span key={j} {...tokenProps} />;
                })}
              </div>
            );
          })}
        </pre>
      )}
    </Highlight>
  );
}

// Inline variant — no pre wrapper, flattens lines into a single row of
// token spans. Used for markdown `code` spans that carry a language
// hint (rare; most inline code is plain). Falls back to the same
// monospace pill when no language is set, since tokenizing without a
// grammar adds noise without color.
export function InlineCode({
  code,
  language,
  className,
}: {
  code: string;
  language: string;
  className?: string;
}) {
  const theme = usePrismTheme();
  const safeCode = typeof code === "string" ? code : "";
  const safeLang = typeof language === "string" && language.length > 0 ? language : "text";
  const stripped = safeCode.replace(/\n+$/, "");
  return (
    <Highlight code={stripped} language={safeLang} theme={theme}>
      {({ tokens, getTokenProps }) => (
        <code className={cn("aui-md-inline-code font-mono text-[0.85em]", className)}>
          {tokens.flat().map((token, i) => {
            const { key: _k, ...props } = getTokenProps({ token });
            return <span key={i} {...props} />;
          })}
        </code>
      )}
    </Highlight>
  );
}
