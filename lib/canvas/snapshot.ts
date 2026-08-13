import { CanvasDocumentBody, type CanvasDocumentT } from "@/lib/canvas/types";

// ponytail: thin loader for the persisted canvas document. The
// shape on disk is `{ nodes, edges }` per `lib/canvas/types.ts`.
// We accept any unknown JSON, parse through zod, and return either
// a clean document or `null` on failure. The CanvasEditor calls
// this after a successful GET to `/api/canvas/:threadId` and
// passes the result to React Flow's `defaultNodes` / `defaultEdges`.
// A missing row → 404 → null → caller skips the load and starts
// with an empty canvas (the first save creates the row).

export const EMPTY_DOCUMENT: CanvasDocumentT = { nodes: [], edges: [] };

export function parseCanvasDocument(raw: unknown): CanvasDocumentT {
  if (!raw || typeof raw !== "object") return EMPTY_DOCUMENT;
  const parsed = CanvasDocumentBody.safeParse(raw);
  if (!parsed.success) return EMPTY_DOCUMENT;
  return parsed.data;
}
