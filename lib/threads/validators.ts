import { z } from "zod";

// API request body schemas for /api/threads/*.
// Each schema is the single source of truth for what the route accepts.

export const CreateThreadBody = z.object({
  title: z.string().min(1).max(200).optional(),
});

export const RenameThreadBody = z.object({
  title: z.string().min(1).max(200),
});

export const UpdateStatusBody = z.object({
  status: z.enum(["regular", "archived"]),
});

export const UpdateCustomBody = z.object({
  custom: z.record(z.string(), z.unknown()),
});

export const MessageRole = z.enum(["user", "assistant", "system"]);

export const GenerateTitleBody = z.object({
  messages: z
    .array(
      z.object({
        role: MessageRole,
        content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
      }),
    )
    .min(1)
    .max(20),
});

export type CreateThreadInput = z.infer<typeof CreateThreadBody>;
export type RenameThreadInput = z.infer<typeof RenameThreadBody>;
export type UpdateStatusInput = z.infer<typeof UpdateStatusBody>;
export type UpdateCustomInput = z.infer<typeof UpdateCustomBody>;
export type GenerateTitleInput = z.infer<typeof GenerateTitleBody>;
