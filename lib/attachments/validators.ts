import { z } from "zod";

// API request body schemas for /api/attachments/*.
// Each schema is the single source of truth for what the route accepts.

// POST /api/attachments/presign — body the adapter sends when a file is picked.
// No threadId: attachments are not bound to threads (Q3 design). The renderer
// reads content parts directly off the message; this row only tracks upload
// metadata for dedup + retention sweeps.
//
// sha256: optional 64-char hex. When set, the route short-circuits to the
// existing uploaded row's publicUrl if a (user_id, sha256) match is found.
// Clients that don't compute a hash (e.g. older browsers, server-side
// flows) leave it undefined — dedup just doesn't run for them.
export const PresignBody = z.object({
  name: z.string().min(1).max(256),
  contentType: z.string().min(1).max(127),
  sizeBytes: z.number().int().positive(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "sha256 must be 64-char hex")
    .optional(),
});

// POST /api/attachments/[id]/confirm — currently empty; HEAD reads R2.
export const ConfirmBody = z.object({}).strict();

// URL params shared across the [id] subroutes.
export const AttachmentIdParam = z.object({ id: z.string().min(1).max(64) });

export type PresignInput = z.infer<typeof PresignBody>;
