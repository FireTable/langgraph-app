import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";

const { mockGetProfileDoc, mockGetRecentThreadSummaries, mockGetSocialAccounts, mockGetSession } =
  vi.hoisted(() => ({
    mockGetProfileDoc: vi.fn(),
    mockGetRecentThreadSummaries: vi.fn(),
    mockGetSocialAccounts: vi.fn(),
    mockGetSession: vi.fn(),
  }));

vi.mock("@/lib/memory/queries", () => ({
  getProfileDoc: mockGetProfileDoc,
  getRecentThreadSummaries: mockGetRecentThreadSummaries,
  getSocialAccounts: mockGetSocialAccounts,
}));

vi.mock("@/lib/auth/config", () => ({
  auth: { api: { getSession: mockGetSession } },
}));

import { withMemoryRecall } from "@/backend/middleware/with-memory-recall";

function fakeModel(): BaseChatModel {
  const invoke = vi.fn(async () => ({ content: "ok" }));
  const bindTools = vi.fn(() => fakeModel());
  const fake = { invoke, bindTools } as unknown as BaseChatModel;
  return fake;
}

describe("withMemoryRecall", () => {
  beforeEach(() => {
    mockGetProfileDoc.mockReset();
    mockGetRecentThreadSummaries.mockReset();
    mockGetSocialAccounts.mockReset();
    mockGetSession.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it("passes through unchanged when userId is absent (FR-007)", async () => {
    const inner = fakeModel();
    const wrapped = withMemoryRecall(inner);
    const messages: BaseMessage[] = [];
    await wrapped.invoke(messages);
    expect(inner.invoke).toHaveBeenCalledTimes(1);
    expect(inner.invoke).toHaveBeenCalledWith(messages, undefined);
  });

  it("passes through when userId is empty string", async () => {
    const inner = fakeModel();
    const wrapped = withMemoryRecall(inner);
    await wrapped.invoke([], { configurable: { userId: "" } });
    expect(inner.invoke).toHaveBeenCalledWith([], {
      configurable: { userId: "" },
    });
  });

  it("prepends a <memory> system message with profile + session + socialAccounts + threads top-K", async () => {
    mockGetProfileDoc.mockResolvedValueOnce({ role: "frontend" });
    mockGetSession.mockResolvedValueOnce({
      user: { id: "u1", name: "Yongzhuo", email: "y@x.com", image: null },
    });
    mockGetSocialAccounts.mockResolvedValueOnce([{ provider: "github" }]);
    mockGetRecentThreadSummaries.mockResolvedValueOnce([
      {
        key: "t1:1",
        value: {
          threadId: "t1",
          sequence: 1,
          name: "intro",
          description: "met",
          startMessageIndex: 0,
          endMessageIndex: 6,
          messageCount: 7,
          updatedAt: "2026-07-02T00:00:00.000Z",
        },
      },
    ]);

    const inner = fakeModel();
    const wrapped = withMemoryRecall(inner);
    await wrapped.invoke([], { configurable: { userId: "u1" } });

    const calledWith = (inner.invoke as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as BaseMessage[];
    expect(Array.isArray(calledWith)).toBe(true);
    expect(calledWith.length).toBe(1);
    const sysMsg = calledWith[0];
    const text = String((sysMsg as { content: unknown }).content);
    expect(text).toContain("<memory>");
    expect(text).toContain("frontend");
    expect(text).toContain("Yongzhuo");
    expect(text).toContain("github");
    expect(text).toContain("intro");
  });

  it("forwards headers into auth.api.getSession (so cookie auth works)", async () => {
    mockGetProfileDoc.mockResolvedValueOnce({});
    mockGetSession.mockResolvedValueOnce(null);
    mockGetSocialAccounts.mockResolvedValueOnce([]);
    mockGetRecentThreadSummaries.mockResolvedValueOnce([]);

    await withMemoryRecall(fakeModel()).invoke([], {
      configurable: { userId: "u1" },
    });
    expect(mockGetSession).toHaveBeenCalledTimes(1);
  });

  it("does not throw when socialAccounts query fails (middleware is best-effort)", async () => {
    mockGetProfileDoc.mockResolvedValueOnce({});
    mockGetSession.mockResolvedValueOnce(null);
    mockGetSocialAccounts.mockRejectedValueOnce(new Error("db down"));
    mockGetRecentThreadSummaries.mockResolvedValueOnce([]);

    const inner = fakeModel();
    const wrapped = withMemoryRecall(inner);
    await expect(wrapped.invoke([], { configurable: { userId: "u1" } })).resolves.toBeDefined();
    expect(inner.invoke).toHaveBeenCalledTimes(1);
  });
});
