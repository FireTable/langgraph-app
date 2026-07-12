import { aesGcmEncrypt, deriveKeyName, loadKek } from "@/lib/auth/encryption";
import type { ProviderApiKey } from "@/lib/provider/schema";
import type { provider } from "@/lib/provider/schema";

/**
 * Public projection of a provider row. Strips `encryptedKey` + `iv` from
 * apiKey entries — the secret material is server-side only. Admin UIs list
 * `name` (the derived "sk-…xyz9" first-3 + last-4) for rotation flows.
 */
export type PublicProviderApiKey = {
  name: string;
};

export type PublicProvider = {
  id: string;
  name: string;
  enabled: boolean;
  baseUrl: string;
  apiKeys: PublicProviderApiKey[];
  models: typeof provider.$inferSelect.models;
  createdAt: Date;
  updatedAt: Date;
};

export function stripProviderSecrets(row: typeof provider.$inferSelect): PublicProvider {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    baseUrl: row.baseUrl,
    apiKeys: row.apiKeys.map(({ name }) => ({ name })),
    models: row.models,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function encryptApiKey(plaintext: string): ProviderApiKey {
  const kek = loadKek();
  const blob = aesGcmEncrypt(plaintext, kek);
  return { ...blob, name: deriveKeyName(plaintext) };
}
