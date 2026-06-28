"use client";

// ponytail: inline banners shared by tool-ui cards. Two variants:
//   - ErrorBanner — destructive surface for tool failures
//   - SuccessBanner — neutral muted surface for confirmed/resolved states
// Both are flat (no shadow) and rely on the parent tool-call chrome for
// padding, so they don't add margin (rule #6).

import { AlertTriangleIcon, CheckIcon } from "lucide-react";
import type { FC, ReactNode } from "react";

import { cn } from "@/lib/utils";

export type ErrorBannerProps = {
  message: ReactNode;
  /** Override the leading icon (e.g. AlertCircleIcon for permission errors). */
  icon?: ReactNode;
  /** Switch to a monospace font for code/stack-trace content. */
  monospace?: boolean;
  className?: string;
};

export const ErrorBanner: FC<ErrorBannerProps> = ({
  message,
  icon,
  monospace = false,
  className,
}) => (
  <div
    className={cn(
      "text-destructive-foreground border-destructive/40 bg-destructive/10 flex items-start gap-2 overflow-hidden rounded-lg border px-3 py-2 text-sm",
      className,
    )}
  >
    {icon ?? <AlertTriangleIcon className="text-destructive mt-0.5 size-4 shrink-0" />}
    <span
      className={cn(
        "text-destructive/90 min-w-0 flex-1",
        monospace && "font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all",
      )}
    >
      {message}
    </span>
  </div>
);

export type SuccessBannerProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Override the leading icon (default is a plain Check — no circle, see rule #8). */
  icon?: ReactNode;
  className?: string;
};

export const SuccessBanner: FC<SuccessBannerProps> = ({ title, subtitle, icon, className }) => (
  <div
    className={cn(
      "border-border/60 bg-muted/40 text-foreground flex items-center gap-3 overflow-hidden rounded-lg border px-3 py-2.5",
      className,
    )}
  >
    {icon ?? <CheckIcon className="text-primary size-5 shrink-0" />}
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm font-medium">{title}</p>
      {subtitle != null && <p className="text-muted-foreground mt-0.5 text-xs">{subtitle}</p>}
    </div>
  </div>
);
