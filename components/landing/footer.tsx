// ponytail: marketing footer. Three columns: brand + one-liner,
// link groups, social/license. The brand column carries a single
// auth-aware CTA mirror (Sign in / Open chat) — keeps the path
// to the chat one click away without competing with the GitHub
// link that's already in the Project column.

import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import type { FC } from "react";

import { APP_NAME } from "@/lib/constants";
import { Button } from "@/components/ui/button";

const PRODUCT_LINKS = [
  { label: "Features", href: "#features" },
  { label: "How it works", href: "#how-it-works" },
  { label: "Self-host", href: "#self-host" },
];

const PROJECT_LINKS = [
  { label: "GitHub", href: "https://github.com/FireTable/langgraph-app", external: true },
  { label: "Issues", href: "https://github.com/FireTable/langgraph-app/issues", external: true },
  {
    label: "Changelog",
    href: "https://github.com/FireTable/langgraph-app/releases",
    external: true,
  },
];

const LEGAL_LINKS = [
  {
    label: "MIT License",
    href: "https://github.com/FireTable/langgraph-app/blob/main/LICENSE",
    external: true,
  },
];

const COLUMNS = [
  { heading: "Product", links: PRODUCT_LINKS },
  { heading: "Project", links: PROJECT_LINKS },
  { heading: "Legal", links: LEGAL_LINKS },
];

export type FooterProps = {
  signedIn: boolean | null;
};

export const Footer: FC<FooterProps> = ({ signedIn }) => {
  const isAuthed = signedIn === true;
  const ctaLabel = isAuthed ? "Open chat" : "Sign in";
  const ctaHref = isAuthed ? "/chat" : "/login";

  return (
    <footer className="border-border/60 border-t">
      <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-10 px-6 py-16 md:grid-cols-[1.4fr_repeat(3,minmax(0,1fr))]">
        <div className="flex flex-col gap-4">
          <Link
            href="/"
            className="text-foreground flex items-center gap-2 text-sm font-semibold tracking-tight"
          >
            {/* <span
              aria-hidden
              className="bg-foreground/90 inline-flex size-5 items-center justify-center rounded-md text-[11px] font-bold text-background"
            >
              L
            </span> */}
            {APP_NAME}
          </Link>
          <p className="text-muted-foreground max-w-xs text-sm leading-relaxed">
            A self-hostable chat surface for a real LangGraph agent. Streaming chat, background
            work, memory, observability — the parts of an LLM product you would otherwise rebuild
            every time.
          </p>
        </div>

        {COLUMNS.map((col) => (
          <div key={col.heading} className="flex flex-col gap-3">
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {col.heading}
            </p>
            <ul className="flex flex-col gap-2">
              {col.links.map((link) => (
                <li key={link.href}>
                  {"external" in link && link.external ? (
                    <a
                      href={link.href}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-foreground/90 hover:text-foreground text-sm transition-colors"
                    >
                      {link.label}
                    </a>
                  ) : (
                    <a
                      href={link.href}
                      className="text-foreground/90 hover:text-foreground text-sm transition-colors"
                    >
                      {link.label}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="border-border/60 border-t">
        <div className="text-muted-foreground mx-auto flex w-full max-w-6xl flex-col items-start justify-between gap-2 px-6 py-5 text-xs sm:flex-row sm:items-center">
          <p>
            © {new Date().getFullYear()} {APP_NAME}. Released under the MIT License.
          </p>
          <p>Built with Next.js, LangGraph, and Drizzle.</p>
        </div>
      </div>
    </footer>
  );
};
