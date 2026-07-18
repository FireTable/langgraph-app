import { pgTable, text, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";

/**
 * Per-row API key entry inside `provider.apiKeys`.
 * Encrypted at rest with AES-256-GCM (see lib/auth/encryption.ts);
 * `name` is the auto-derived last-4-chars plaintext tail for UI display
 * only — the encrypted blob + iv are the source of truth.
 */
export type ProviderApiKey = {
  encryptedKey: string; // AES-256-GCM ciphertext, base64
  iv: string; // 12-byte nonce, base64
  name: string; // e.g. "sk-…xyz9", auto-derived at create time
};

/**
 * Per-model rate config inside `provider.models`.
 * Credits are computed at call time as
 *   (inputTokens / 1000) * inputPer1k + (outputTokens / 1000) * outputPer1k
 * — frozen into credit_usage_log.credits on success; rate changes after
 * the fact are not retroactively recomputed (correct billing semantics).
 */
// ponytail: model kinds split by *capability domain*, not by task type.
//   chat   — reasoning + tool use, the default pool.
//   ocr    — vision-capable chat models used for PDF page → markdown.
//   embed  — dense-vector models for KB chunk embeddings.
//   extract — chat models earmarked for structured-output extraction
//             (entity / relationship / theme triples from KB chunks).
//             A model with `kind: ["extract", "chat"]` is eligible for
//             both pools — the route is decided by the caller, not by
//             `kind`. Today the kbAgent entity-LLM call site stays on
//             the chat pool; "extract" exists so admin can flag a
//             cheaper model (e.g. gpt-4o-mini) as the canonical
//             extraction surface without forcing it to also be the
//             chat default.
export type ModelKind = "chat" | "ocr" | "embed" | "extract";

/**
 * Per-model rate config inside `provider.models`.
 * Credits are computed at call time as
 *   (inputTokens / 1000) * inputPer1k + (outputTokens / 1000) * outputPer1k
 * — frozen into credit_usage_log.credits on success; rate changes after
 * the fact are not retroactively recomputed (correct billing semantics).
 */
export type ModelConfig = {
  name: string; // "gpt-4o-mini"
  enabled: boolean;
  inputPer1k: number; // credits / 1k input tokens
  outputPer1k: number; // credits / 1k output tokens
  // ponytail: which pool this model belongs to. A model can serve multiple
  // kinds (gpt-4o-mini is both chat and ocr) so it's an array. Omitted ⇒
  // ["chat"] for back-compat with seed rows created before v1 KB. The
  // `extract` kind marks a chat-capable model as the preferred surface
  // for structured-output extraction (see lib/credit/zod.ts modelKindSchema).
  kind?: ModelKind[];
};

/**
 * Provider registry. Holds the API key pool + per-model rates for one
 * upstream (openai / anthropic / ...). `apiKeys` stays an array for
 * forward compatibility — today we use apiKeys[0]; future priority-based
 * fallback needs no schema change.
 */
export const provider = pgTable("provider", {
  id: text("id").primaryKey(), // "openai" / "anthropic"
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  // ponytail: baseUrl lives on the provider row (not on each apiKey) because
  // a provider's endpoint is a property of the upstream, not of the auth
  // material. Callback metadata → findProviderId() matches this to recover
  // providerId without scanning jsonb.
  baseUrl: text("base_url").notNull(),
  apiKeys: jsonb("api_keys").$type<ProviderApiKey[]>().notNull().default([]),
  models: jsonb("models").$type<ModelConfig[]>().notNull().default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});
