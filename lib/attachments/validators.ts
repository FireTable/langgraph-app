import { z } from "zod";

// API request body schemas for /api/attachments/*.
// Each schema is the single source of truth for what the route accepts.

// POST /api/attachments/presign — body the adapter sends when a file is picked.
export const PresignBody = z.object({
  name: z.string().min(1).max(256),
  contentType: z.string().min(1).max(127),
  sizeBytes: z.number().int().positive(),
  threadId: z.string().min(1).max(128).optional(),
});

// POST /api/attachments/[id]/confirm — currently empty; HEAD reads R2.
export const ConfirmBody = z.object({}).strict();

// URL params shared across the [id] subroutes.
export const AttachmentIdParam = z.object({ id: z.string().min(1).max(64) });

export type PresignInput = z.infer<typeof PresignBody>;
