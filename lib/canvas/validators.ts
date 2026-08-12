import { z } from "zod";

// ponytail: the API accepts an arbitrary tldraw TLDocument payload. We
// don't restate the shape here — tldraw's loader validates the document
// when the client calls loadSnapshot (see lib/canvas/snapshot.ts). A
// tighter zod schema would duplicate tldraw's validation and drift as
// tldraw evolves.
//
// The only thing we DO enforce is "this is a non-null object" — a
// malformed PUT (string, null, array) is a 400. z.record() rejects
// arrays (number keys, not string) and primitives, accepts {} and any
// shape, so we lean on that.
export const CanvasDocumentBody = z.record(z.string(), z.unknown());

export const PutCanvasBody = z.object({
  document: CanvasDocumentBody,
});

export type PutCanvasInput = z.infer<typeof PutCanvasBody>;
