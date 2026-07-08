// ponytail: marketing header. Sticky, blurred, with brand on the
// left, anchor nav in the middle, GitHub + auth-aware CTA on the
// right. Server component — the only client island is the CTA
// (which is the same component the hero uses, by design: copy stays
// in sync without us having to thread a prop through a wrapper).
// The GitHub glyph is a small inline SVG because the installed
// lucide-react version (1.23.0) does not export a `Github` icon.

import Link from "next/link";
import type { FC } from "react";

import { APP_NAME } from "@/lib/constants";
import { HeroCta } from "@/components/landing/hero-cta";
import { cn } from "@/lib/utils";

const REPO_URL = "https://github.com/FireTable/langgraph-app";

const NAV_LINKS: Array<{ label: string; href: string }> = [
  { label: "Features", href: "#features" },
  { label: "How it works", href: "#how-it-works" },
  { label: "Self-host", href: "#self-host" },
];

export type HeaderProps = {
  signedIn: boolean | null;
};

export const Header: FC<HeaderProps> = ({ signedIn }) => (
  <header
    className={cn(
      "sticky top-0 z-50 w-full border-b border-border/60",
      "bg-background/70 supports-[backdrop-filter]:bg-background/60 backdrop-blur",
    )}
  >
    <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-6 px-6">
      <Link
        href="/"
        aria-label={`${APP_NAME} — home`}
        className="text-foreground/90 hover:text-foreground flex items-center gap-2 text-sm font-semibold tracking-tight transition-colors"
      >
        {/* <span
          aria-hidden
          className="bg-foreground/90 inline-flex size-5 items-center justify-center rounded-md text-[11px] font-bold text-background"
        >
          L
        </span> */}
        {APP_NAME}
      </Link>

      <nav aria-label="Primary" className="hidden flex-1 items-center gap-6 md:flex">
        {NAV_LINKS.map((link) => (
          <a
            key={link.href}
            href={link.href}
            className="text-muted-foreground hover:text-foreground text-sm transition-colors"
          >
            {link.label}
          </a>
        ))}
      </nav>

      <div className="ml-auto flex items-center gap-2">
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={`${APP_NAME} on GitHub`}
          className="text-muted-foreground hover:text-foreground inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className="size-4">
            <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.92.58.11.79-.25.79-.56v-2c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.18 1.18.92-.26 1.91-.39 2.89-.39.98 0 1.97.13 2.89.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.24 2.75.12 3.04.74.81 1.18 1.84 1.18 3.1 0 4.42-2.7 5.39-5.27 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.68.8.56C20.21 21.38 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5Z" />
          </svg>
          <span className="hidden sm:inline">GitHub</span>
        </a>
        <span className="inline-flex">
          <HeroCta signedIn={signedIn} compact />
        </span>
      </div>
    </div>
  </header>
);
