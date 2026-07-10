import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetMemoryDoc, mockPutMemoryDoc, mockGetAuthInfo } = vi.hoisted(() => ({
  mockGetMemoryDoc: vi.fn(),
  mockPutMemoryDoc: vi.fn(),
  mockGetAuthInfo: vi.fn(),
}));

vi.mock("@/lib/memory/queries", () => ({
  getMemoryDoc: mockGetMemoryDoc,
  putMemoryDoc: mockPutMemoryDoc,
  getAuthInfo: mockGetAuthInfo,
  EMPTY_AUTH_INFO: { name: null, email: null, avatar: null, socials: [] },
}));

import { saveMemoryTool } from "@/backend/tool/memory/save-memory-tool";

const cfg = (userId: string | null) => ({
  configurable: userId ? { userId } : {},
});

describe("saveMemoryTool — patch matrix (FR-001..003)", () => {
  beforeEach(() => {
    mockGetMemoryDoc.mockReset();
    mockPutMemoryDoc.mockReset();
    // ponytail: default to no-auth so patches operate on a clean
    // store-only doc. Tests that need auth overlay set it explicitly.
    mockGetAuthInfo.mockReset();
    mockGetAuthInfo.mockResolvedValue({
      name: null,
      email: null,
      image: null,
      socials: [],
    });
  });
  afterEach(() => vi.clearAllMocks());

  it("adds a key on an empty profile", async () => {
    mockGetMemoryDoc.mockResolvedValueOnce({});
    mockPutMemoryDoc.mockResolvedValueOnce(undefined);
    const out = await saveMemoryTool.invoke(
      { patches: [{ op: "add", path: "/role", value: "frontend" }] },
      cfg("u1"),
    );
    expect(mockPutMemoryDoc).toHaveBeenCalledWith("u1", { role: "frontend" });
    const result = JSON.parse(out as string);
    expect(result).toMatchObject({ ok: true, keyCount: 1 });
    expect(result.before).toEqual({});
    expect(result.after).toEqual({ role: "frontend" });
    expect(result.patches).toEqual([{ op: "add", path: "role", value: "frontend" }]);
  });

  it("rejects a data-URL / base64 blob value (issue #28) without writing", async () => {
    mockGetMemoryDoc.mockResolvedValueOnce({});
    const dataUrl = `data:image/png;base64,${"A".repeat(600)}`;
    await expect(
      saveMemoryTool.invoke(
        { patches: [{ op: "add", path: "/avatar", value: dataUrl }] },
        cfg("u1"),
      ),
    ).rejects.toThrow(/base64/i);
    expect(mockPutMemoryDoc).not.toHaveBeenCalled();
  });

  it("rejects a base64 blob nested inside an object value", async () => {
    mockGetMemoryDoc.mockResolvedValueOnce({});
    await expect(
      saveMemoryTool.invoke(
        { patches: [{ op: "add", path: "/pic", value: { raw: "B".repeat(700) } }] },
        cfg("u1"),
      ),
    ).rejects.toThrow(/base64/i);
    expect(mockPutMemoryDoc).not.toHaveBeenCalled();
  });

  it("rejects a url-safe (base64url) blob with -_ chars", async () => {
    mockGetMemoryDoc.mockResolvedValueOnce({});
    const blob = `${"a-b_".repeat(150)}`; // 600 chars of [a-z-_]
    await expect(
      saveMemoryTool.invoke({ patches: [{ op: "add", path: "/pic", value: blob }] }, cfg("u1")),
    ).rejects.toThrow(/base64/i);
    expect(mockPutMemoryDoc).not.toHaveBeenCalled();
  });

  it("does not flag short normal values (wallet address / hash)", async () => {
    mockGetMemoryDoc.mockResolvedValueOnce({});
    mockPutMemoryDoc.mockResolvedValueOnce(undefined);
    await saveMemoryTool.invoke(
      { patches: [{ op: "add", path: "/wallet", value: "0xAbC123def456" }] },
      cfg("u1"),
    );
    expect(mockPutMemoryDoc).toHaveBeenCalledWith("u1", { wallet: "0xAbC123def456" });
  });

  it("merges multiple adds with existing keys (non-destructive)", async () => {
    mockGetMemoryDoc.mockResolvedValueOnce({ language: "zh" });
    mockPutMemoryDoc.mockResolvedValueOnce(undefined);
    await saveMemoryTool.invoke(
      {
        patches: [
          { op: "add", path: "/role", value: "frontend" },
          { op: "add", path: "/wallet", value: "0xabc" },
        ],
      },
      cfg("u1"),
    );
    expect(mockPutMemoryDoc).toHaveBeenCalledWith("u1", {
      language: "zh",
      role: "frontend",
      wallet: "0xabc",
    });
  });

  it("replace overwrites an existing field, leaves others intact", async () => {
    mockGetMemoryDoc.mockResolvedValueOnce({ role: "frontend", language: "zh" });
    mockPutMemoryDoc.mockResolvedValueOnce(undefined);
    await saveMemoryTool.invoke(
      { patches: [{ op: "replace", path: "/role", value: "backend" }] },
      cfg("u1"),
    );
    expect(mockPutMemoryDoc).toHaveBeenCalledWith("u1", {
      role: "backend",
      language: "zh",
    });
  });

  it("remove deletes a field", async () => {
    mockGetMemoryDoc.mockResolvedValueOnce({ role: "frontend", wallet: "0xabc" });
    mockPutMemoryDoc.mockResolvedValueOnce(undefined);
    await saveMemoryTool.invoke({ patches: [{ op: "remove", path: "/role" }] }, cfg("u1"));
    expect(mockPutMemoryDoc).toHaveBeenCalledWith("u1", { wallet: "0xabc" });
  });

  it("applies multiple patches in order with each feeding into the next", async () => {
    mockGetMemoryDoc.mockResolvedValueOnce({ role: "frontend" });
    mockPutMemoryDoc.mockResolvedValueOnce(undefined);
    await saveMemoryTool.invoke(
      {
        patches: [
          { op: "replace", path: "/role", value: "backend" },
          { op: "add", path: "/wallet", value: "0xabc" },
          { op: "remove", path: "/role" },
        ],
      },
      cfg("u1"),
    );
    expect(mockPutMemoryDoc).toHaveBeenCalledWith("u1", { wallet: "0xabc" });
  });

  it("rejects a patch set that would exceed profile size (FR-003)", async () => {
    mockGetMemoryDoc.mockResolvedValueOnce({});
    // ponytail: spaced text so it trips the SIZE guard, not the base64
    // guard (a long unbroken A-Za-z0-9 run would look like a blob).
    const padding = "long note ".repeat(900);
    await expect(
      saveMemoryTool.invoke({ patches: [{ op: "add", path: "/note", value: padding }] }, cfg("u1")),
    ).rejects.toThrow(/exceeds|MemorySize|profile size/i);
    expect(mockPutMemoryDoc).not.toHaveBeenCalled();
  });

  it("rejects a remove patch whose path is not in the profile", async () => {
    mockGetMemoryDoc.mockResolvedValueOnce({ language: "zh" });
    await expect(
      saveMemoryTool.invoke({ patches: [{ op: "remove", path: "/role" }] }, cfg("u1")),
    ).rejects.toThrow(/not found|missing|patch/i);
    expect(mockPutMemoryDoc).not.toHaveBeenCalled();
  });

  it("rejects a replace patch whose path is not in the profile", async () => {
    mockGetMemoryDoc.mockResolvedValueOnce({});
    await expect(
      saveMemoryTool.invoke({ patches: [{ op: "replace", path: "/role", value: "x" }] }, cfg("u1")),
    ).rejects.toThrow(/not found|missing|patch/i);
    expect(mockPutMemoryDoc).not.toHaveBeenCalled();
  });

  it("rejects move / copy / test ops at the schema layer", async () => {
    await expect(
      saveMemoryTool.invoke(
        { patches: [{ op: "move", from: "/role", path: "/role2" } as never] },
        cfg("u1"),
      ),
    ).rejects.toThrow();
  });

  it("empty patches array is a no-op success", async () => {
    mockGetMemoryDoc.mockResolvedValueOnce({ role: "frontend" });
    mockPutMemoryDoc.mockResolvedValueOnce(undefined);
    await saveMemoryTool.invoke({ patches: [] }, cfg("u1"));
    expect(mockPutMemoryDoc).toHaveBeenCalledWith("u1", { role: "frontend" });
  });

  it("returns before/after + normalized patches for the SaveMemoryCard to render", async () => {
    mockGetMemoryDoc.mockResolvedValueOnce({ city: "Berlin" });
    mockPutMemoryDoc.mockResolvedValueOnce(undefined);
    const out = await saveMemoryTool.invoke(
      {
        patches: [
          { op: "add", path: "/name", value: "Lin" },
          { op: "replace", path: "/city", value: "Munich" },
          { op: "remove", path: "/city" },
          { op: "add", path: "/city", value: "Hamburg" },
        ],
      },
      cfg("u1"),
    );
    const result = JSON.parse(out as string);
    expect(result.before).toEqual({ city: "Berlin" });
    expect(result.after).toEqual({ name: "Lin", city: "Hamburg" });
    // The first replace against `Berlin` carries the pre-patch value;
    // the remove carries the post-replace value (`Munich`); the add
    // never has an oldValue.
    expect(result.patches[0]).toEqual({ op: "add", path: "name", value: "Lin" });
    expect(result.patches[1]).toEqual({
      op: "replace",
      path: "city",
      oldValue: "Berlin",
      value: "Munich",
    });
    expect(result.patches[2]).toEqual({ op: "remove", path: "city", oldValue: "Munich" });
    expect(result.patches[3]).toEqual({ op: "add", path: "city", value: "Hamburg" });
  });
});

describe("FR-023 fail-fast vs FR-007 middleware pass-through", () => {
  beforeEach(() => {
    mockGetMemoryDoc.mockReset();
    mockPutMemoryDoc.mockReset();
    mockGetAuthInfo.mockReset();
    mockGetAuthInfo.mockResolvedValue({
      name: null,
      email: null,
      image: null,
      socials: [],
    });
  });
  afterEach(() => vi.clearAllMocks());

  it("config undefined — throws MissingUserIdError, store.put never called", async () => {
    await expect(
      saveMemoryTool.invoke({
        patches: [{ op: "add", path: "/role", value: "frontend" }],
      }),
    ).rejects.toMatchObject({ code: "MISSING_USER_ID" });
    expect(mockPutMemoryDoc).not.toHaveBeenCalled();
  });

  it("config.configurable undefined — same", async () => {
    await expect(
      saveMemoryTool.invoke(
        {
          patches: [{ op: "add", path: "/role", value: "frontend" }],
        },
        {},
      ),
    ).rejects.toMatchObject({ code: "MISSING_USER_ID" });
    expect(mockPutMemoryDoc).not.toHaveBeenCalled();
  });

  it("config.configurable.userId = '' — empty is treated as missing", async () => {
    await expect(
      saveMemoryTool.invoke(
        { patches: [{ op: "add", path: "/role", value: "frontend" }] },
        cfg(""),
      ),
    ).rejects.toMatchObject({ code: "MISSING_USER_ID" });
    expect(mockPutMemoryDoc).not.toHaveBeenCalled();
  });

  it("valid userId — normal path succeeds", async () => {
    mockGetMemoryDoc.mockResolvedValueOnce({});
    mockPutMemoryDoc.mockResolvedValueOnce(undefined);
    await expect(
      saveMemoryTool.invoke(
        { patches: [{ op: "add", path: "/role", value: "frontend" }] },
        cfg("u1"),
      ),
    ).resolves.toBeDefined();
    expect(mockPutMemoryDoc).toHaveBeenCalledTimes(1);
  });
});

describe("saveMemoryTool.description — system prompt source of truth", () => {
  // ponytail: the system prompt's <save_memory_rule> collapsed to an
  // index pointing at this description. If a future maintainer trims
  // rules out of the description without updating the system prompt,
  // the model loses them silently — these assertions pin the contract.
  const desc = saveMemoryTool.description;

  it("documents WHEN TO CALL triggers (explicit + durable + tool-call)", () => {
    expect(desc).toMatch(/WHEN TO CALL/i);
    expect(desc).toMatch(/explicitly states/i);
    expect(desc).toMatch(/durable fact/i);
    expect(desc).toMatch(/tool calls/i);
  });

  it("documents CONSTRAINTS (skip categories + per-turn cap)", () => {
    expect(desc).toMatch(/CONSTRAINTS/i);
    expect(desc).toMatch(/ephemeral/i);
    expect(desc).toMatch(/sensitive/i);
    expect(desc).toMatch(/external data/i);
    expect(desc).toMatch(/once per turn/i);
  });

  it("documents CONFLICT RESOLUTION (clarifying question before overwrite)", () => {
    expect(desc).toMatch(/CONFLICT RESOLUTION/i);
    expect(desc).toMatch(/clarifying question/i);
  });

  it("documents FALLBACK when tool is unavailable", () => {
    expect(desc).toMatch(/FALLBACK/i);
    expect(desc).toMatch(/not in your current tool list/i);
  });

  it("documents SCHEMA for RFC 6902 patches", () => {
    expect(desc).toMatch(/SCHEMA/i);
    expect(desc).toMatch(/patches/i);
    expect(desc).toMatch(/add|replace|remove/i);
  });

  it("includes add + replace + remove examples (replace uses existing memory)", () => {
    // example 1: add (no prior memory)
    expect(desc).toMatch(/Lin/i);
    expect(desc).toMatch(/"add"/);
    // example 2: replace (existing memory has city)
    expect(desc).toMatch(/replace/i);
    expect(desc).toMatch(/Berlin/i);
    expect(desc).toMatch(/Munich/i);
    // example 3: remove (existing memory has wallet)
    expect(desc).toMatch(/remove/i);
    expect(desc).toMatch(/wallet/i);
  });
});
