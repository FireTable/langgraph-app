import * as React from "react";

import { cn } from "@/lib/utils";

// ponytail: a status pill — uses surface + foreground tokens that
// already adapt to light/dark. Variants carry semantic colour
// (success = green-ish) without resorting to per-state colour
// classes everywhere. Match the shadcn badge API surface so a
// future shadcn drop-in is a one-liner swap.
type BadgeVariant = "default" | "secondary" | "outline" | "success" | "muted";

const variantClasses: Record<BadgeVariant, string> = {
  default: "border-transparent bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
  secondary: "border-transparent bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
  outline: "text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
  success:
    "border-transparent bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-300",
  muted: "border-transparent bg-muted text-muted-foreground [a&]:hover:bg-muted/80",
};

function Badge({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"span"> & { variant?: BadgeVariant }) {
  return (
    <span
      data-slot="badge"
      data-variant={variant}
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase whitespace-nowrap transition-colors",
        variantClasses[variant],
        className,
      )}
      {...props}
    />
  );
}

export { Badge };
