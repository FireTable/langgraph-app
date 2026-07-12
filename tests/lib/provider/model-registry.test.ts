import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import {
  provider as providerTable,
  type ModelConfig,
  type ProviderApiKey,
} from "@/lib/provider/schema";
import { aesGcmEncrypt, loadKek } from "@/lib/auth/encryption";
import { getChatModelFromDB, invalidateModelCache } from "@/lib/provider/model-registry";

function encryptFixtureKey(plain: string): ProviderApiKey {
  const blob = aesGcmEncrypt(plain, loadKek());
  return { ...blob, name: `sk-…${plain.slice(-4)}` };
}

const ENABLED_MODEL = (name: string): ModelConfig => ({
  name,
  enabled: true,
  inputPer1k: 0,
  outputPer1k: 0,
});

async function seedProvider(row: {
  id: string;
  enabled?: boolean;
  apiKeys?: ProviderApiKey[];
  models?: ModelConfig[];
  baseUrl?: string;
}) {
  await db.delete(providerTable).where(eq(providerTable.id, row.id));
  await db.insert(providerTable).values({
    id: row.id,
    name: row.id,
    enabled: row.enabled ?? true,
    baseUrl: row.baseUrl ?? "https://api.openai.com/v1",
    apiKeys: row.apiKeys ?? [],
    models: row.models ?? [],
  });
}

beforeEach(async () => {
  await db.delete(providerTable);
  invalidateModelCache();
});

afterAll(async () => {
  invalidateModelCache();
});

describe("getChatModelFromDB", () => {
  it("throws when no enabled provider exists", async () => {
    await expect(getChatModelFromDB()).rejects.toThrow(/no enabled provider/i);
  });

  it("throws when provider has no enabled model", async () => {
    await seedProvider({
      id: "primary",
      models: [{ name: "gpt-4o", enabled: false, inputPer1k: 0, outputPer1k: 0 }],
    });
    await expect(getChatModelFromDB()).rejects.toThrow(/no enabled model/i);
  });

  it("returns the same cached instance on repeat calls (no extra DB read)", async () => {
    await seedProvider({
      id: "primary",
      apiKeys: [encryptFixtureKey("sk-test-1234")],
      models: [ENABLED_MODEL("gpt-4o")],
    });

    const dbSpy = vi.spyOn(db, "select");
    const callsAfterSpy = dbSpy.mock.calls.length;
    const first = await getChatModelFromDB();
    const callsAfterFirst = dbSpy.mock.calls.length;
    const second = await getChatModelFromDB();
    const callsAfterSecond = dbSpy.mock.calls.length;

    expect(first).toBe(second);
    expect(callsAfterFirst).toBe(callsAfterSpy + 1); // first call hits DB exactly once
    expect(callsAfterSecond).toBe(callsAfterFirst); // second call hits DB zero times
    dbSpy.mockRestore();
  });

  it("respects explicit providerId / modelName opts", async () => {
    await seedProvider({
      id: "primary",
      apiKeys: [encryptFixtureKey("sk-primary-9999")],
      models: [ENABLED_MODEL("gpt-4o")],
    });
    await seedProvider({
      id: "secondary",
      apiKeys: [encryptFixtureKey("sk-secondary-8888")],
      models: [ENABLED_MODEL("claude-3")],
    });

    const explicitPrimary = await getChatModelFromDB({
      providerId: "primary",
      modelName: "gpt-4o",
    });
    const explicitSecondary = await getChatModelFromDB({
      providerId: "secondary",
      modelName: "claude-3",
    });

    // ponytail: distinct (provider, model) keys → distinct cached instances.
    expect(explicitPrimary).not.toBe(explicitSecondary);
  });

  it("returns a different instance after invalidateModelCache", async () => {
    await seedProvider({
      id: "primary",
      apiKeys: [encryptFixtureKey("sk-test-1234")],
      models: [ENABLED_MODEL("gpt-4o")],
    });

    const first = await getChatModelFromDB();
    invalidateModelCache();
    const second = await getChatModelFromDB();

    expect(first).not.toBe(second);
  });

  it("survives multiple apiKeys (random selection, no decryption error)", async () => {
    await seedProvider({
      id: "primary",
      apiKeys: [
        encryptFixtureKey("sk-first-1111"),
        encryptFixtureKey("sk-second-2222"),
        encryptFixtureKey("sk-third-3333"),
      ],
      models: [ENABLED_MODEL("gpt-4o")],
    });

    // Both picks must produce a usable model — we can't read the random
    // choice directly, but if decrypt or ChatOpenAI ctor threw we'd see it
    // here.
    const model = await getChatModelFromDB();
    expect(model).toBeDefined();
    expect(typeof model.invoke).toBe("function");
  });
});

describe("invalidateModelCache", () => {
  it("clears a single (provider, model) key when given", async () => {
    await seedProvider({
      id: "primary",
      apiKeys: [encryptFixtureKey("sk-test-1234")],
      models: [ENABLED_MODEL("gpt-4o"), ENABLED_MODEL("gpt-4o-mini")],
    });

    const a = await getChatModelFromDB({ providerId: "primary", modelName: "gpt-4o" });
    const b = await getChatModelFromDB({ providerId: "primary", modelName: "gpt-4o-mini" });

    invalidateModelCache("primary:gpt-4o");

    const a2 = await getChatModelFromDB({ providerId: "primary", modelName: "gpt-4o" });
    const b2 = await getChatModelFromDB({ providerId: "primary", modelName: "gpt-4o-mini" });

    expect(a).not.toBe(a2);
    expect(b).toBe(b2); // untouched
  });
});
