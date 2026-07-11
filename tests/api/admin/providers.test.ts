import "@/tests/helpers/session";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/db/client";
import { provider } from "@/lib/provider/schema";
import { setCurrentUser } from "@/tests/helpers/session";
import { TEST_USER } from "@/tests/helpers/auth";

import { GET, POST } from "@/app/api/admin/providers/route";
import { PATCH, DELETE } from "@/app/api/admin/providers/[id]/route";
import { POST as AddKey } from "@/app/api/admin/providers/[id]/keys/route";
import { PATCH as RotateKey } from "@/app/api/admin/providers/[id]/keys/[keyName]/route";
import { POST as AddModel } from "@/app/api/admin/providers/[id]/models/route";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = { params: Promise.resolve(undefined as never) };
const ctxId = (id: string) => ({ params: Promise.resolve({ id }) });
const ctxKey = (id: string, keyName: string) => ({ params: Promise.resolve({ id, keyName }) });

const ADMIN = { id: TEST_USER.id, email: TEST_USER.email, roleId: "admin" };
const PLAINTEXT = "sk-test-plaintext-secret-1234";

beforeAll(() => {
  // ponytail: loadKek() reads process.env per call (no module-scope
  // cache), so any 64-hex value works. Tests only need encryption to be
  // deterministic-ish — the assertion is "plaintext never appears in any
  // response", not "the ciphertext matches across runs".
  process.env.LLM_KEY_ENCRYPTION_KEY ??= "a".repeat(64);
});

beforeEach(async () => {
  await db.delete(provider);
  setCurrentUser(ADMIN);
});

afterAll(async () => {
  setCurrentUser(null);
});

describe("GET /api/admin/providers", () => {
  it("returns 401 when unauthenticated", async () => {
    setCurrentUser(null);
    const res = await GET(new Request("http://localhost"), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when signed in but role is 'user'", async () => {
    setCurrentUser({ id: TEST_USER.id, email: TEST_USER.email, roleId: "user" });
    const res = await GET(new Request("http://localhost"), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 200 with providers when admin", async () => {
    await db
      .insert(provider)
      .values({ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" })
      .onConflictDoNothing();
    const res = await GET(new Request("http://localhost"), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0].id).toBe("openai");
  });

  it("never exposes encryptedKey, iv, or the plaintext apiKey in any response", async () => {
    // Simulate what POST should have produced: the API key entry contains
    // encryptedKey + iv but never the plaintext. Insert directly with a
    // known blob, then verify GET strips it.
    await db
      .insert(provider)
      .values({
        id: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        apiKeys: [
          {
            encryptedKey: "blob-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            iv: "iv-bbbbbbbbbbbb",
            name: "...1234",
          },
        ],
      })
      .onConflictDoNothing();
    const res = await GET(new Request("http://localhost"), ctx);
    const body = await res.json();
    const text = JSON.stringify(body);
    expect(text).not.toContain("encryptedKey");
    expect(text).not.toContain("blob-aaa");
    expect(text).not.toContain("iv-bbbbb");
    expect(text).not.toContain("iv");
    expect(text).not.toContain(PLAINTEXT);

    expect(body.providers[0].apiKeys[0]).toEqual({ name: "...1234" });
  });
});

describe("POST /api/admin/providers", () => {
  it("returns 201 and creates the row when admin", async () => {
    const res = await POST(
      jsonRequest({
        id: "openai",
        name: "OpenAI",
        enabled: true,
        baseUrl: "https://api.openai.com/v1",
        apiKeys: [],
        models: [],
      }),
      ctx,
    );
    expect(res.status).toBe(201);
    const row = await db.query.provider.findFirst({ where: (p, { eq }) => eq(p.id, "openai") });
    expect(row).toBeDefined();
  });

  it("returns 400 on missing required fields", async () => {
    const res = await POST(jsonRequest({ id: "x" }), ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid id format (uppercase / spaces)", async () => {
    const res = await POST(jsonRequest({ id: "Bad Id", name: "X" }), ctx);
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/admin/providers/[id]", () => {
  it("returns 200 and applies the partial update", async () => {
    await db
      .insert(provider)
      .values({
        id: "anthropic",
        name: "Old",
        enabled: false,
        baseUrl: "https://api.anthropic.com/v1",
      })
      .onConflictDoNothing();
    const res = await PATCH(jsonRequest({ name: "New", enabled: true }), ctxId("anthropic"));
    expect(res.status).toBe(200);
    const row = await db.query.provider.findFirst({ where: (p, { eq }) => eq(p.id, "anthropic") });
    expect(row?.name).toBe("New");
    expect(row?.enabled).toBe(true);
  });

  it("returns 400 on empty patch body", async () => {
    await db
      .insert(provider)
      .values({ id: "anthropic", name: "X", baseUrl: "https://api.anthropic.com/v1" })
      .onConflictDoNothing();
    const res = await PATCH(jsonRequest({}), ctxId("anthropic"));
    expect(res.status).toBe(400);
  });

  it("returns 404 when the provider does not exist", async () => {
    const res = await PATCH(jsonRequest({ name: "X" }), ctxId("missing"));
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/admin/providers/[id]", () => {
  it("returns 204 and removes the row", async () => {
    await db
      .insert(provider)
      .values({ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" })
      .onConflictDoNothing();
    const res = await DELETE(new Request("http://localhost"), ctxId("openai"));
    expect(res.status).toBe(204);
    const row = await db.query.provider.findFirst({ where: (p, { eq }) => eq(p.id, "openai") });
    expect(row).toBeUndefined();
  });

  it("returns 404 when missing", async () => {
    const res = await DELETE(new Request("http://localhost"), ctxId("missing"));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/admin/providers/[id]/keys (encryption)", () => {
  it("encrypts the plaintext and strips both ciphertext and iv from the response", async () => {
    await db
      .insert(provider)
      .values({ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" })
      .onConflictDoNothing();
    const res = await AddKey(jsonRequest({ plaintext: PLAINTEXT }), ctxId("openai"));
    expect(res.status).toBe(201);
    const body = await res.json();
    const text = JSON.stringify(body);
    expect(text).not.toContain(PLAINTEXT);
    expect(text).not.toContain("encryptedKey");
    expect(text).not.toContain("iv");
    expect(body.apiKeys[0].name).toBe("...1234");

    const row = await db.query.provider.findFirst({ where: (p, { eq }) => eq(p.id, "openai") });
    expect(row?.apiKeys[0].encryptedKey).toBeTruthy();
    expect(row?.apiKeys[0].iv).toBeTruthy();
    expect(JSON.stringify(row?.apiKeys)).not.toContain(PLAINTEXT);
  });

  it("returns 409 on duplicate derived name", async () => {
    await db
      .insert(provider)
      .values({ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" })
      .onConflictDoNothing();
    await AddKey(jsonRequest({ plaintext: PLAINTEXT }), ctxId("openai"));
    const res = await AddKey(jsonRequest({ plaintext: PLAINTEXT }), ctxId("openai"));
    expect(res.status).toBe(409);
  });
});

describe("PATCH /api/admin/providers/[id]/keys/[keyName] (rotate)", () => {
  it("re-encrypts and keeps the same name; never leaks the new plaintext", async () => {
    await db
      .insert(provider)
      .values({ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" })
      .onConflictDoNothing();
    await AddKey(jsonRequest({ plaintext: PLAINTEXT }), ctxId("openai"));
    const before = await db.query.provider.findFirst({ where: (p, { eq }) => eq(p.id, "openai") });
    const beforeBlob = before!.apiKeys[0].encryptedKey;

    const NEW = "sk-test-rotated-secret-9999";
    const res = await RotateKey(jsonRequest({ plaintext: NEW }), ctxKey("openai", "...1234"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(NEW);
    expect(text).not.toContain(PLAINTEXT);

    const after = await db.query.provider.findFirst({ where: (p, { eq }) => eq(p.id, "openai") });
    expect(after!.apiKeys[0].name).toBe("...1234");
    expect(after!.apiKeys[0].encryptedKey).not.toBe(beforeBlob);
  });

  it("returns 404 when the keyName does not exist", async () => {
    await db
      .insert(provider)
      .values({ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" })
      .onConflictDoNothing();
    const res = await RotateKey(jsonRequest({ plaintext: "x" }), ctxKey("openai", "...zzzz"));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/admin/providers/[id]/models", () => {
  it("appends a model and returns 201", async () => {
    await db
      .insert(provider)
      .values({ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" })
      .onConflictDoNothing();
    const res = await AddModel(
      jsonRequest({ name: "gpt-4o-mini", enabled: true, inputPer1k: 0.001, outputPer1k: 0.002 }),
      ctxId("openai"),
    );
    expect(res.status).toBe(201);
    const row = await db.query.provider.findFirst({ where: (p, { eq }) => eq(p.id, "openai") });
    expect(row?.models[0].name).toBe("gpt-4o-mini");
  });

  it("returns 400 on missing required fields", async () => {
    await db
      .insert(provider)
      .values({ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" })
      .onConflictDoNothing();
    const res = await AddModel(jsonRequest({ name: "x" }), ctxId("openai"));
    expect(res.status).toBe(400);
  });

  it("returns 409 on duplicate model name", async () => {
    await db
      .insert(provider)
      .values({ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" })
      .onConflictDoNothing();
    await AddModel(
      jsonRequest({ name: "m", enabled: true, inputPer1k: 0, outputPer1k: 0 }),
      ctxId("openai"),
    );
    const res = await AddModel(
      jsonRequest({ name: "m", enabled: true, inputPer1k: 0, outputPer1k: 0 }),
      ctxId("openai"),
    );
    expect(res.status).toBe(409);
  });
});
