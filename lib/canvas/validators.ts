import { z } from "zod";
import { CanvasDocumentBody } from "@/lib/canvas/types";

export { CanvasDocumentBody };

// ponytail: the API accepts a `{ nodes, edges }` canvas document
// matching `lib/canvas/types.ts`. The full React Flow state
// (viewport, selection) is intentionally NOT persisted — those are
// per-session. Nodes / edges are sufficient to round-trip the
// pipeline graph.
export const PutCanvasBody = z.object({
  document: CanvasDocumentBody,
});

export type PutCanvasInput = z.infer<typeof PutCanvasBody>;
