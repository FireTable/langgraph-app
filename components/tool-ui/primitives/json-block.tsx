// ponytail: shared pretty-printed JSON block. Extracted from
// observability/panel.tsx so the memory settings view can render its
// structured profile fields with the same chrome the user already
// sees in the observability panel — same muted background, same mono
// font, same scroll-on-overflow. `maxHeight` is enforced so a deep
// payload doesn't push the rest of the card off-screen; callers who
// know the data is short can pass a larger value or `undefined` to
// let it grow.
import type { FC } from "react";

export type JsonBlockProps = {
  data: unknown;
  /** Default 240px matches the observability panel. Pass a larger value or omit for tall payloads. */
  maxHeight?: number;
};

export const JsonBlock: FC<JsonBlockProps> = ({ data, maxHeight = 240 }) => (
  <pre
    className="bg-muted/50 text-foreground overflow-auto rounded-md p-2.5 font-mono text-xs whitespace-pre-wrap"
    style={maxHeight !== undefined ? { maxHeight } : undefined}
  >
    {typeof data === "string" ? data : JSON.stringify(data, null, 2)}
  </pre>
);
