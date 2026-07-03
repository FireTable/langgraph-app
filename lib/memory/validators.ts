import { z } from "zod";

// RFC 6902 JSON Patch operations. Move / copy / test are rejected — the
// profile is a flat k-v bag and structured merge / path-traversal isn't a
// useful primitive for save_memory.
// ponytail: profile is a flat k-v bag — keys look like object property
// names, not array indices. `^\/[A-Za-z_]` rejects `/0`, `/123` (array
// indices) while still accepting `/role`, `/roleName`, `/role-name`.
const RFC6901_KEY = z
  .string()
  .regex(
    /^\/[A-Za-z_][A-Za-z0-9_-]*$/,
    "path must be `/<key>` where key starts with a letter or underscore",
  );

const MemoryPatchBase = z.object({
  path: RFC6901_KEY,
});

export const MemoryPatchSchema = z.discriminatedUnion("op", [
  MemoryPatchBase.extend({
    op: z.literal("add"),
    value: z.unknown(),
  }),
  MemoryPatchBase.extend({
    op: z.literal("replace"),
    value: z.unknown(),
  }),
  MemoryPatchBase.extend({
    op: z.literal("remove"),
  }),
]);

export const SaveMemoryInputSchema = z.object({
  patches: z.array(MemoryPatchSchema).min(0).max(50),
});

export const SummaryEntrySchema = z
  .object({
    threadId: z.string().min(1),
    sequence: z.number().int().positive(),
    name: z.string().min(1),
    description: z.string().min(1),
    startMessageIndex: z.number().int().nonnegative(),
    endMessageIndex: z.number().int().nonnegative(),
    messageCount: z.number().int().positive(),
    updatedAt: z.string().datetime(),
  })
  // ponytail: closed-interval invariant — messageCount MUST equal the
  // inclusive count, not the half-open count. The schema rejects drift
  // between storage and derivation, so a future maintainer editing the
  // node's reducer learns the bug at write-time, not at recall time.
  .refine(
    (s) => s.messageCount === s.endMessageIndex - s.startMessageIndex + 1,
    "messageCount must equal endMessageIndex - startMessageIndex + 1",
  );

export const MemoryResponseSchema = z.object({
  // ponytail: `memory` is the user-saved doc overlaid with live auth
  // (name/email/image/socials from drizzle user+account tables). Model
  // and UI both see the same merged shape — one function (`loadMemory`)
  // is the single source of truth.
  memory: z.record(z.string(), z.unknown()),
  threads: z.array(
    z.object({
      key: z.string(),
      value: SummaryEntrySchema,
    }),
  ),
});

export const ThreadSummaryGroupSchema = z.object({
  threadId: z.string().min(1),
  summaries: z.array(SummaryEntrySchema),
});

export const ThreadsResponseSchema = z.object({
  threads: z.array(ThreadSummaryGroupSchema),
});

export const ProfileDeleteResponseSchema = z.object({
  ok: z.literal(true),
  deletedKey: z.string().min(1),
});

export const ThreadsDeleteResponseSchema = z.object({
  ok: z.literal(true),
  deletedCount: z.number().int().nonnegative(),
});

export type MemoryPatch = z.infer<typeof MemoryPatchSchema>;
export type SaveMemoryInput = z.infer<typeof SaveMemoryInputSchema>;
export type MemoryResponse = z.infer<typeof MemoryResponseSchema>;
export type ThreadsResponse = z.infer<typeof ThreadsResponseSchema>;
export type SummaryEntry = z.infer<typeof SummaryEntrySchema>;
export type ThreadSummaryGroup = z.infer<typeof ThreadSummaryGroupSchema>;
export type ProfileDeleteResponse = z.infer<typeof ProfileDeleteResponseSchema>;
export type ThreadsDeleteResponse = z.infer<typeof ThreadsDeleteResponseSchema>;
