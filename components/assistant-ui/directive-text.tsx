"use client";

import { type TextMessagePartComponent } from "@assistant-ui/react";

import { renderDirectiveSegments } from "@/components/assistant-ui/directive-chip";

// ponytail: render the user-message text content with `:kb-document[…]`
// and `:kb-folder[…]` directives as inline chips instead of raw text.
// aUI ships `DirectiveText` (install via shadcn), but its default
// formatter + plain `<Badge>` styling doesn't match our visual
// language. The chip rendering itself lives in `directive-chip.tsx`
// so the editable composer (DirectiveComposerInput) and this
// read-only bubble renderer share one source of truth.
//
// `unstable_defaultDirectiveFormatter.parse` returns alternating
// `text` and `mention` segments. We render text as plain spans and
// mentions as chips with the right icon.

export const DirectiveText: TextMessagePartComponent = ({ text }) => {
  return <>{renderDirectiveSegments(text)}</>;
};
