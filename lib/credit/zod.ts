import { z } from "zod";

export const roleIdSchema = z.enum(["guest", "user", "admin"]);

export const callStatusSchema = z.enum(["success", "error"]);

export const providerApiKeySchema = z.object({
  encryptedKey: z.string().min(1),
  iv: z.string().min(1),
  name: z.string().min(1).max(64),
});

// ponytail: model kinds — chat = general purpose, ocr = vision-capable
// chat model used to extract text from rendered PDF pages, embed =
// embedding model for KB chunks. A single upstream model can serve
// multiple kinds (gpt-4o-mini is both chat + ocr).
export const modelKindSchema = z.enum(["chat", "ocr", "embed"]);

export const modelConfigSchema = z.object({
  name: z.string().min(1).max(128),
  enabled: z.boolean(),
  inputPer1k: z.number().min(0),
  outputPer1k: z.number().min(0),
  // ponytail: backend defaults to ["chat"] when omitted, so clients
  // never have to send it for a chat-only model. Persisted as-is on
  // the JSONB row; the registry's `m.kind ?? ["chat"]` back-compat
  // path keeps old rows (no kind field) eligible for chat traffic.
  kind: z.array(modelKindSchema).default(["chat"]),
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
//
// apiKeys is also stripped from the PATCH schema: encrypted material
// must travel through `POST /providers/[id]/keys` which routes through
// `encryptApiKey` — a hand-crafted `apiKeys[]` here would write the
// caller's plaintext-or-garbage directly into the jsonb and fail later
// at `aesGcmDecrypt` with no signal. `models` stays — it carries no
// secrets, only rate config.
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
  models: z.array(modelConfigSchema).optional(),
});
export const providerPatchSchema = providerNoDefaults;

// ponytail: PATCH-shape keeps `kind` strict and optional — empty array
// is rejected (a model with no kind doesn't make sense; the default
// `["chat"]` would silently replace an intentional empty). Replacing
// the whole array is the only legal way to update kind via PATCH.
export const modelPatchSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  enabled: z.boolean().optional(),
  inputPer1k: z.number().min(0).optional(),
  outputPer1k: z.number().min(0).optional(),
  kind: z.array(modelKindSchema).min(1).optional(),
});

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
