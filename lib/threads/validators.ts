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

export type CreateThreadInput = z.infer<typeof CreateThreadBody>;
export type RenameThreadInput = z.infer<typeof RenameThreadBody>;
export type UpdateStatusInput = z.infer<typeof UpdateStatusBody>;
export type UpdateCustomInput = z.infer<typeof UpdateCustomBody>;
