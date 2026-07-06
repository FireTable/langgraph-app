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

// ponytail: SummaryEntry = metadata for ONE in-thread compression pass.
//   - threadId + sequence        = identity / ordering inside the thread.
//   - startMessageIndex..endMessageIndex + messageCount = closed-interval
//     range of human-only turn indices the summary covers.
//   - messageIds                 = parallel array of the BaseMessage.id
//     values the compression replaced; required so a future tool can
//     rehydrate the original messages by id (or re-summarize differently
//     without re-tokenizing). Program-resolved (the LLM never sees it).
//   - summary                    = the formatted Q&A text the LLM
//     produced (e.g. "#1-#4 Q: … A: …\n#5-#6 Q: … A: …"). What the
//     model sees at invoke time via the <threads> system block; what
//     the user sees in the Memory tab list.
//   - triggerReason              = WHY this pass fired. "turn_based" today
//     (KEEP_RECENT cadence); future "token_based" once a max-tokens
//     secondary trim lands. Closed enum keeps analytics strict.
//   - tokenCountBefore/After     = bookkeeping — tokens in the compressed
//     excerpt vs tokens in the summary, measured via
//     @langchain/core/messages/utils.countTokensApproximately. Lets a
//     future UI render compression stats and stops the trigger from
//     drifting silently.
//   - createdAt                  = when this batch was generated.
//     Renamed from updatedAt because summaries are immutable once written.
const summaryMessageCount = z.number().int().positive();
const summaryMinIndex = z.number().int().nonnegative();

export const SummaryEntrySchema = z
  .object({
    threadId: z.string().min(1),
    sequence: z.number().int().positive(),
    startMessageIndex: summaryMinIndex,
    endMessageIndex: summaryMinIndex,
    messageCount: summaryMessageCount,
    messageIds: z.array(z.string().min(1)).nonempty(),
    summary: z.string().min(1),
    triggerReason: z.enum(["turn_based", "token_based"]),
    tokenCountBefore: z.number().int().nonnegative(),
    tokenCountAfter: z.number().int().nonnegative(),
    // ponytail: zod v4 moved format shorthands to top-level helpers;
    // z.string().datetime() is deprecated. z.iso.datetime() validates
    // an ISO-8601 datetime (the same shape new Date().toISOString()
    // emits) without the deprecation warning.
    createdAt: z.iso.datetime(),
  })
  // ponytail: closed-interval invariant — messageCount MUST equal the
  // inclusive count, not the half-open count. The schema rejects drift
  // between storage and derivation, so a future maintainer editing the
  // node's reducer learns the bug at write-time, not at recall time.
  .refine(
    (s) => s.messageCount === s.endMessageIndex - s.startMessageIndex + 1,
    "messageCount must equal endMessageIndex - startMessageIndex + 1",
  )
  // ponytail: messageIds length MUST equal messageCount — the ids array
  // is positional over the closed human-only interval, so off-by-one
  // indicates the program-side mapping is wrong.
  .refine(
    (s) => s.messageIds.length === s.messageCount,
    "messageIds length must equal messageCount",
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
