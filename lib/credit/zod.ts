import { z } from "zod";

export const roleIdSchema = z.enum(["guest", "user", "admin"]);

export const callStatusSchema = z.enum(["success", "error"]);

export const providerApiKeySchema = z.object({
  encryptedKey: z.string().min(1),
  iv: z.string().min(1),
  name: z.string().min(1).max(64),
});

export const modelConfigSchema = z.object({
  name: z.string().min(1).max(128),
  enabled: z.boolean(),
  inputPer1k: z.number().min(0),
  outputPer1k: z.number().min(0),
});

export const providerInputSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/, "id must be lowercase alphanum/_/-"),
  name: z.string().min(1).max(128),
  enabled: z.boolean().default(true),
  baseUrl: z.url(),
  apiKeys: z.array(providerApiKeySchema).default([]),
  models: z.array(modelConfigSchema).default([]),
});

export const roleInputSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/),
  name: z.string().min(1).max(128),
  creditLimit: z.number().int().min(0).nullable(),
  windowHours: z.number().int().min(1).max(720).default(24),
});

// ponytail: PATCH schemas drop the input-side defaults so an empty body
// fails strict (handler returns 400). `.partial()` alone would still
// accept `{}` because the defaults fill in — `enabled: true`,
// `apiKeys: []`, etc. — and the handler would silently rewrite the row.
const providerNoDefaults = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/)
    .optional(),
  name: z.string().min(1).max(128).optional(),
  enabled: z.boolean().optional(),
  baseUrl: z.url().optional(),
  apiKeys: z.array(providerApiKeySchema).optional(),
  models: z.array(modelConfigSchema).optional(),
});
export const providerPatchSchema = providerNoDefaults;

const roleNoDefaults = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/)
    .optional(),
  name: z.string().min(1).max(128).optional(),
  creditLimit: z.number().int().min(0).nullable().optional(),
  windowHours: z.number().int().min(1).max(720).optional(),
});
export const rolePatchSchema = roleNoDefaults;
