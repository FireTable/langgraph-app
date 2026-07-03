import type { FC } from "react";
import Link from "next/link";
import { MessageSquareTextIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { APP_NAME } from "@/lib/constants";

const TEXT_CLASS = "text-foreground/90 ml-2 text-sm font-medium whitespace-nowrap";

// ponytail: app logo block — icon + APP_NAME in a single rounded row.
// The collapse animation lives on the text node (opacity-0 when
// `collapsed`) and on the row's horizontal padding (px-3.5 vs px-6),
// so the consumer passes both `collapsed` and a `className` for
// layout-level padding/spacing. We intentionally don't add a
// background, border, or hover state — Sidebar slots it into a column
// header and BrandMarkLink slots it into a settings page top bar.
export const BrandMark: FC<{ collapsed?: boolean; className?: string }> = ({
  collapsed = false,
  className,
}) => (
  <div className={cn("flex h-12 shrink-0 items-center", className)}>
    <MessageSquareTextIcon className="text-foreground/90 size-5 shrink-0" />
    <span className={cn(TEXT_CLASS, "transition-opacity duration-200", collapsed && "opacity-0")}>
      {APP_NAME}
    </span>
  </div>
);

// ponytail: same chrome as BrandMark, but as a clickable link to
// /chat — used in places (like /settings) where the user needs an
// obvious "back to chat" affordance but the page has no sidebar of
// its own.
export const BrandMarkLink: FC<{ className?: string; href?: string }> = ({
  className,
  href = "/chat",
}) => (
  <Link
    href={href}
    className={cn("inline-flex items-center rounded-md transition-colors", className)}
  >
    <BrandMark />
  </Link>
);
