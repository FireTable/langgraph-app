import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetProfileDoc, mockPutProfileDoc } = vi.hoisted(() => ({
  mockGetProfileDoc: vi.fn(),
  mockPutProfileDoc: vi.fn(),
}));

vi.mock("@/lib/memory/queries", () => ({
  getProfileDoc: mockGetProfileDoc,
  putProfileDoc: mockPutProfileDoc,
}));

import { saveMemoryTool } from "@/backend/tool/memory/save-memory-tool";

const cfg = (userId: string | null) => ({
  configurable: userId ? { userId } : {},
});

describe("saveMemoryTool — patch matrix (FR-001..003)", () => {
  beforeEach(() => {
    mockGetProfileDoc.mockReset();
    mockPutProfileDoc.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it("adds a key on an empty profile", async () => {
    mockGetProfileDoc.mockResolvedValueOnce({});
    mockPutProfileDoc.mockResolvedValueOnce(undefined);
    const out = await saveMemoryTool.invoke(
      { patches: [{ op: "add", path: "/role", value: "frontend" }] },
      cfg("u1"),
    );
    expect(mockPutProfileDoc).toHaveBeenCalledWith("u1", { role: "frontend" });
    expect(JSON.parse(out as string)).toMatchObject({ ok: true, keyCount: 1 });
  });

  it("merges multiple adds with existing keys (non-destructive)", async () => {
    mockGetProfileDoc.mockResolvedValueOnce({ language: "zh" });
    mockPutProfileDoc.mockResolvedValueOnce(undefined);
    await saveMemoryTool.invoke(
      {
        patches: [
          { op: "add", path: "/role", value: "frontend" },
          { op: "add", path: "/wallet", value: "0xabc" },
        ],
      },
      cfg("u1"),
    );
    expect(mockPutProfileDoc).toHaveBeenCalledWith("u1", {
      language: "zh",
      role: "frontend",
      wallet: "0xabc",
    });
  });

  it("replace overwrites an existing field, leaves others intact", async () => {
    mockGetProfileDoc.mockResolvedValueOnce({ role: "frontend", language: "zh" });
    mockPutProfileDoc.mockResolvedValueOnce(undefined);
    await saveMemoryTool.invoke(
      { patches: [{ op: "replace", path: "/role", value: "backend" }] },
      cfg("u1"),
    );
    expect(mockPutProfileDoc).toHaveBeenCalledWith("u1", {
      role: "backend",
      language: "zh",
    });
  });

  it("remove deletes a field", async () => {
    mockGetProfileDoc.mockResolvedValueOnce({ role: "frontend", wallet: "0xabc" });
    mockPutProfileDoc.mockResolvedValueOnce(undefined);
    await saveMemoryTool.invoke({ patches: [{ op: "remove", path: "/role" }] }, cfg("u1"));
    expect(mockPutProfileDoc).toHaveBeenCalledWith("u1", { wallet: "0xabc" });
  });

  it("applies multiple patches in order with each feeding into the next", async () => {
    mockGetProfileDoc.mockResolvedValueOnce({ role: "frontend" });
    mockPutProfileDoc.mockResolvedValueOnce(undefined);
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
    expect(mockPutProfileDoc).toHaveBeenCalledWith("u1", { wallet: "0xabc" });
  });

  it("rejects a patch set that would exceed profile size (FR-003)", async () => {
    mockGetProfileDoc.mockResolvedValueOnce({});
    const padding = "x".repeat(9000);
    await expect(
      saveMemoryTool.invoke({ patches: [{ op: "add", path: "/note", value: padding }] }, cfg("u1")),
    ).rejects.toThrow(/exceeds|MemorySize|profile size/i);
    expect(mockPutProfileDoc).not.toHaveBeenCalled();
  });

  it("rejects a remove patch whose path is not in the profile", async () => {
    mockGetProfileDoc.mockResolvedValueOnce({ language: "zh" });
    await expect(
      saveMemoryTool.invoke({ patches: [{ op: "remove", path: "/role" }] }, cfg("u1")),
    ).rejects.toThrow(/not found|missing|patch/i);
    expect(mockPutProfileDoc).not.toHaveBeenCalled();
  });

  it("rejects a replace patch whose path is not in the profile", async () => {
    mockGetProfileDoc.mockResolvedValueOnce({});
    await expect(
      saveMemoryTool.invoke({ patches: [{ op: "replace", path: "/role", value: "x" }] }, cfg("u1")),
    ).rejects.toThrow(/not found|missing|patch/i);
    expect(mockPutProfileDoc).not.toHaveBeenCalled();
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
    mockGetProfileDoc.mockResolvedValueOnce({ role: "frontend" });
    mockPutProfileDoc.mockResolvedValueOnce(undefined);
    await saveMemoryTool.invoke({ patches: [] }, cfg("u1"));
    expect(mockPutProfileDoc).toHaveBeenCalledWith("u1", { role: "frontend" });
  });
});

describe("FR-023 fail-fast vs FR-007 middleware pass-through", () => {
  beforeEach(() => {
    mockGetProfileDoc.mockReset();
    mockPutProfileDoc.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it("config undefined — throws MissingUserIdError, store.put never called", async () => {
    await expect(
      saveMemoryTool.invoke({
        patches: [{ op: "add", path: "/role", value: "frontend" }],
      }),
    ).rejects.toMatchObject({ code: "MISSING_USER_ID" });
    expect(mockPutProfileDoc).not.toHaveBeenCalled();
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
    expect(mockPutProfileDoc).not.toHaveBeenCalled();
  });

  it("config.configurable.userId = '' — empty is treated as missing", async () => {
    await expect(
      saveMemoryTool.invoke(
        { patches: [{ op: "add", path: "/role", value: "frontend" }] },
        cfg(""),
      ),
    ).rejects.toMatchObject({ code: "MISSING_USER_ID" });
    expect(mockPutProfileDoc).not.toHaveBeenCalled();
  });

  it("valid userId — normal path succeeds", async () => {
    mockGetProfileDoc.mockResolvedValueOnce({});
    mockPutProfileDoc.mockResolvedValueOnce(undefined);
    await expect(
      saveMemoryTool.invoke(
        { patches: [{ op: "add", path: "/role", value: "frontend" }] },
        cfg("u1"),
      ),
    ).resolves.toBeDefined();
    expect(mockPutProfileDoc).toHaveBeenCalledTimes(1);
  });
});
