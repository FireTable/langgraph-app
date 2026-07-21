import { z } from "zod";

// API request body schemas for /api/attachments/*.
// Each schema is the single source of truth for what the route accepts.

// POST /api/attachments/presign — body the adapter sends when a file is picked.
// No threadId: attachments are not bound to threads (Q3 design). The renderer
// reads content parts directly off the message; this row only tracks upload
// metadata for dedup + retention sweeps.
//
// sha256: REQUIRED 64-char hex. The route uses sha256 as the R2 key
// (content-addressed — same bytes → same key → automatic dedup at the
// storage layer). Clients must compute sha256 via `crypto.subtle.digest`
// before sending; the adapter throws if `crypto.subtle` isn't available,
// forcing the user to a modern browser (secure context required).
export const PresignBody = z.object({
  name: z.string().min(1).max(256),
  contentType: z.string().min(1).max(127),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i, "sha256 must be 64-char hex"),
});

// POST /api/attachments/[id]/confirm — currently empty; HEAD reads R2.
export const ConfirmBody = z.object({}).strict();

// URL params shared across the [id] subroutes.
export const AttachmentIdParam = z.object({ id: z.string().min(1).max(64) });

// POST /api/avatar/presign — body the client sends when picking a new
// avatar. Mirrors PresignBody but WITHOUT sha256: the avatar R2 key
// is a fixed per-user slot (u/<userId>/avatar.png), so the server
// never needs to know the file's bytes to construct it.
export const AvatarPresignBody = z.object({
  name: z.string().min(1).max(256),
  contentType: z.string().min(1).max(127),
  sizeBytes: z.number().int().positive(),
});

export type PresignInput = z.infer<typeof PresignBody>;
