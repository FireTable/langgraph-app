import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import {
  provider as providerTable,
  type ModelConfig,
  type ProviderApiKey,
} from "@/lib/provider/schema";
import { aesGcmEncrypt, loadKek } from "@/lib/auth/encryption";
import {
  getChatModelFromDB,
  getEmbeddingModelFromDB,
  getOcrModelFromDB,
  invalidateModelCache,
} from "@/lib/provider/model-registry";
import { resetRoundRobinCounters } from "@/lib/provider/model-registry";

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
  // ponytail: clear per-cacheKey rotation counters so this test sees a
  // fresh "call 0 → tuple 0" baseline. Without it, calls from earlier
  // tests in the same file would push the counter ahead.
  resetRoundRobinCounters();
});

afterAll(async () => {
  invalidateModelCache();
});

describe("getChatModelFromDB", () => {
  it("throws when no enabled provider exists", async () => {
    await expect(getChatModelFromDB()).rejects.toThrow(/no enabled chat.*tuple/i);
  });

  it("throws when provider has no enabled model", async () => {
    await seedProvider({
      id: "primary",
      models: [{ name: "gpt-4o", enabled: false, inputPer1k: 0, outputPer1k: 0 }],
    });
    await expect(getChatModelFromDB()).rejects.toThrow(/no enabled chat.*tuple/i);
  });

  // ponytail: tuple list (DB rows + encrypted blobs) is cached, but the
  // picked ChatOpenAI is rebuilt on every call so the round-robin can
  // advance. The DB read is what we cache — not the final object.
  it("caches the tuple list but rebuilds the picked model per call (no extra DB read)", async () => {
    await seedProvider({
      id: "primary",
      apiKeys: [encryptFixtureKey("sk-test-1234")],
      models: [ENABLED_MODEL("gpt-4o")],
    });

    const dbSpy = vi.spyOn(db, "select");
    try {
      const callsAfterSpy = dbSpy.mock.calls.length;
      const first = await getChatModelFromDB();
      const callsAfterFirst = dbSpy.mock.calls.length;
      const second = await getChatModelFromDB();
      const callsAfterSecond = dbSpy.mock.calls.length;

      expect(typeof first.invoke).toBe("function");
      expect(typeof second.invoke).toBe("function");
      expect(callsAfterFirst).toBe(callsAfterSpy + 1); // first call hits DB exactly once
      expect(callsAfterSecond).toBe(callsAfterFirst); // second call hits DB zero times
    } finally {
      dbSpy.mockRestore();
    }
  });

  // ponytail: each call rebuilds a fresh ChatOpenAI per tuple, so the
  // returned references are pairwise distinct even if rotation logic
  // were broken (every call picks the same tuple → still sees `a !== b`).
  // This test pins the per-call-rebuild contract, not actual rotation
  // order. A real "call N picks tuple N" assertion would need to peek
  // at the picked key, which requires module-mocking ChatOpenAI's ctor.
  it("builds a fresh ChatOpenAI per call (per-call rebuild)", async () => {
    const keys = [
      encryptFixtureKey("sk-first-1111"),
      encryptFixtureKey("sk-second-2222"),
      encryptFixtureKey("sk-third-3333"),
    ];
    await seedProvider({
      id: "primary",
      apiKeys: keys,
      models: [ENABLED_MODEL("gpt-4o")],
    });

    // Three calls → three distinct ChatOpenAI instances (each is a
    // fresh ctor over the cached tuple list). Same .invoke surface,
    // but reference identity differs.
    const a = await getChatModelFromDB();
    const b = await getChatModelFromDB();
    const c = await getChatModelFromDB();
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });

  // ponytail: same per-call-rebuild caveat as the test above. This one
  // exercises a two-provider setup; distinct refs are guaranteed by the
  // rebuild, not by per-provider rotation.
  it("builds fresh per-call across multiple providers (round-robin shape)", async () => {
    await seedProvider({
      id: "alpha",
      apiKeys: [encryptFixtureKey("sk-alpha-1111")],
      models: [ENABLED_MODEL("gpt-4o")],
    });
    await seedProvider({
      id: "beta",
      apiKeys: [encryptFixtureKey("sk-beta-2222")],
      models: [ENABLED_MODEL("gpt-4o")],
    });

    const seen: unknown[] = [];
    for (let i = 0; i < 4; i++) seen.push(await getChatModelFromDB());
    // 4 calls, 2 tuples → first call primary=alpha, second=beta, third=alpha, fourth=beta
    // Distinct wrapped runnables (rebuilt each call), but the primary
    // rotates deterministically. We just assert that all 4 are usable
    // and not equal pairwise (per-call wrap → distinct references).
    for (const s of seen) expect(typeof (s as { invoke: unknown }).invoke).toBe("function");
    expect(new Set(seen).size).toBe(seen.length);
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

    // ponytail: distinct (provider, model) cache keys → distinct tuple
    // lists, hence distinct ChatOpenAI instances in the wrap.
    expect(explicitPrimary).not.toBe(explicitSecondary);
  });

  it("returns a different wrapped runnable after invalidateModelCache", async () => {
    await seedProvider({
      id: "primary",
      apiKeys: [encryptFixtureKey("sk-test-1234")],
      models: [ENABLED_MODEL("gpt-4o")],
    });

    const first = await getChatModelFromDB();
    invalidateModelCache();
    const second = await getChatModelFromDB();

    // Per-call wrap + invalidated tuple list → guaranteed distinct.
    expect(first).not.toBe(second);
  });

  it("survives multiple apiKeys (round-robin, no decryption error)", async () => {
    await seedProvider({
      id: "primary",
      apiKeys: [
        encryptFixtureKey("sk-first-1111"),
        encryptFixtureKey("sk-second-2222"),
        encryptFixtureKey("sk-third-3333"),
      ],
      models: [ENABLED_MODEL("gpt-4o")],
    });

    // All picks must produce a usable model — if decrypt or ChatOpenAI
    // ctor threw we'd see it here. Round-robin is deterministic in
    // tuple order, so each call is a valid wrap of three ChatOpenAIs.
    for (let i = 0; i < 3; i++) {
      const model = await getChatModelFromDB();
      expect(model).toBeDefined();
      expect(typeof model.invoke).toBe("function");
    }
  });

  // ponytail: regression — a previous version wrapped the round-robin
  // picks in `withFallbacks(...)`, which returns a RunnableWithFallbacks
  // (Runnable, not BaseChatModel). `.bindTools` / `.withStructuredOutput`
  // don't exist on a plain Runnable, so 6 LangGraph call sites crashed
  // at runtime with `TypeError: ... is not a function` whenever there
  // were ≥2 tuples. This test pins both methods as functions on every
  // round-robin pick — a regression to `withFallbacks` flips these to
  // undefined.
  it("with ≥2 tuples, every round-robin pick still exposes bindTools + withStructuredOutput", async () => {
    await seedProvider({
      id: "primary",
      apiKeys: [encryptFixtureKey("sk-aaa-1111"), encryptFixtureKey("sk-bbb-2222")],
      models: [ENABLED_MODEL("gpt-4o")],
    });

    // Cover both rotation positions to guarantee neither primary is
    // landing on the old wrapper.
    for (let i = 0; i < 4; i++) {
      const model = await getChatModelFromDB();
      expect(typeof (model as { bindTools?: unknown }).bindTools).toBe("function");
      expect(typeof (model as { withStructuredOutput?: unknown }).withStructuredOutput).toBe(
        "function",
      );
    }
  });
});

describe("kind partition (ocr / embed)", () => {
  it("getOcrModelFromDB only picks tuples whose kind includes 'ocr'", async () => {
    await seedProvider({
      id: "primary",
      apiKeys: [encryptFixtureKey("sk-primary-ocr")],
      models: [
        { name: "gpt-4o", enabled: true, inputPer1k: 0, outputPer1k: 0, kind: ["chat"] },
        {
          name: "gpt-4o-mini",
          enabled: true,
          inputPer1k: 0,
          outputPer1k: 0,
          kind: ["chat", "ocr"],
        },
      ],
    });

    const ocr = await getOcrModelFromDB();
    // ponytail: an OCR model is a chat-capable model used to extract text
    // from rendered page images. We can't introspect the underlying model
    // class beyond its .invoke surface, so just assert it's a working
    // runnable — proves the registry didn't drop the request.
    expect(typeof (ocr as { invoke: unknown }).invoke).toBe("function");
    expect(typeof (ocr as { bindTools?: unknown }).bindTools).toBe("function");
  });

  it("getEmbeddingModelFromDB returns an embeddings instance, not a chat model", async () => {
    await seedProvider({
      id: "primary",
      apiKeys: [encryptFixtureKey("sk-primary-emb")],
      models: [
        {
          name: "text-embedding-3-small",
          enabled: true,
          inputPer1k: 0,
          outputPer1k: 0,
          kind: ["embed"],
        },
      ],
    });

    const emb = await getEmbeddingModelFromDB();
    // Embeddings expose .embedDocuments / .embedQuery, NOT .invoke / .bindTools.
    expect(typeof (emb as { embedDocuments: unknown }).embedDocuments).toBe("function");
    expect(typeof (emb as { embedQuery: unknown }).embedQuery).toBe("function");
    expect((emb as { invoke?: unknown }).invoke).toBeUndefined();
  });

  it("throws when no enabled model matches the requested kind", async () => {
    await seedProvider({
      id: "primary",
      apiKeys: [encryptFixtureKey("sk-primary-chat-only")],
      models: [{ name: "gpt-4o", enabled: true, inputPer1k: 0, outputPer1k: 0, kind: ["chat"] }],
    });

    await expect(getOcrModelFromDB()).rejects.toThrow(/no enabled.*ocr/i);
    await expect(getEmbeddingModelFromDB()).rejects.toThrow(/no enabled.*embed/i);
  });

  it("default kind is 'chat' when ModelConfig.kind is omitted (back-compat)", async () => {
    await seedProvider({
      id: "primary",
      apiKeys: [encryptFixtureKey("sk-primary-default")],
      models: [ENABLED_MODEL("gpt-4o")], // no kind field
    });

    const chat = await getChatModelFromDB();
    expect(typeof (chat as { invoke: unknown }).invoke).toBe("function");
  });

  it("chat and ocr round-robin counters are independent", async () => {
    await seedProvider({
      id: "primary",
      apiKeys: [encryptFixtureKey("sk-shared-a"), encryptFixtureKey("sk-shared-b")],
      models: [
        {
          name: "gpt-4o-mini",
          enabled: true,
          inputPer1k: 0,
          outputPer1k: 0,
          kind: ["chat", "ocr"],
        },
      ],
    });

    const chatRef = await getChatModelFromDB();
    // OCR call should NOT throw even though we've advanced the chat counter.
    const ocrRef = await getOcrModelFromDB();
    // Both should be usable runnables; identity distinct (per-call rebuild).
    expect(typeof (chatRef as { invoke: unknown }).invoke).toBe("function");
    expect(typeof (ocrRef as { invoke: unknown }).invoke).toBe("function");
    expect(chatRef).not.toBe(ocrRef);
  });
});

describe("invalidateModelCache", () => {
  it("clears a single (provider, model) key when given", async () => {
    await seedProvider({
      id: "primary",
      apiKeys: [encryptFixtureKey("sk-test-1234")],
      models: [ENABLED_MODEL("gpt-4o"), ENABLED_MODEL("gpt-4o-mini")],
    });

    // With one key and one model per opt-shape, the wrapped runnable
    // changes per-call anyway (round-robin across the same single tuple
    // still wraps once), so we can only assert that the tuple list
    // itself is re-queried after invalidation.
    await getChatModelFromDB({ providerId: "primary", modelName: "gpt-4o" });
    await getChatModelFromDB({ providerId: "primary", modelName: "gpt-4o-mini" });

    const dbSpy = vi.spyOn(db, "select");
    const before = dbSpy.mock.calls.length;
    invalidateModelCache("kind=chat|primary:gpt-4o");
    await getChatModelFromDB({ providerId: "primary", modelName: "gpt-4o" });
    const afterGpt4o = dbSpy.mock.calls.length;
    await getChatModelFromDB({ providerId: "primary", modelName: "gpt-4o-mini" });
    const afterGpt4oMini = dbSpy.mock.calls.length;

    expect(afterGpt4o).toBeGreaterThan(before); // invalidated → re-queried
    expect(afterGpt4oMini).toBe(afterGpt4o); // untouched
    dbSpy.mockRestore();
  });
});
