import * as React from "react";

import { cn } from "@/lib/utils";

// ponytail: a11y-first borderless input for use inside dense table rows
// where a boxed Input would clash with the row's vertical rhythm. Only
// a single bottom border is shown — transparent at rest, foreground on
// focus. Use the boxed `Input` everywhere else (cards, dialogs, forms).
//
// Note: the /admin refactor moved all inline add/edit rows into
// Dialogs (FormDialog + ModelDialog / KeyDialog / RoleDialog), so this
// component is currently unused. Kept because it's a reasonable
// primitive to drop into other dense UIs (chat attachment rows,
// composer's attached-file list, etc.) — drop it entirely if no caller
// shows up in the next pass.
function UnderlineInput({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      data-slot="underline-input"
      className={cn(
        "h-7 w-full min-w-0 border-0 border-b border-transparent bg-transparent px-0 text-sm shadow-none outline-none transition-colors",
        "placeholder:text-muted-foreground/60",
        "focus-visible:border-foreground",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { UnderlineInput };