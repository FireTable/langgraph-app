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
  return { invoke, bindTools: vi.fn(() => fakeModel()) } as unknown as BaseChatModel;
}

describe("withMemoryRecall — session + social accounts (US4)", () => {
  beforeEach(() => {
    mockGetProfileDoc.mockReset();
    mockGetRecentThreadSummaries.mockReset();
    mockGetSocialAccounts.mockReset();
    mockGetSession.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it("system message JSON contains session.email / session.name / socialAccounts[].provider", async () => {
    mockGetProfileDoc.mockResolvedValueOnce({});
    mockGetSession.mockResolvedValueOnce({
      user: { id: "u1", name: "Yongzhuo", email: "y@x.com", image: null },
    });
    mockGetSocialAccounts.mockResolvedValueOnce([{ provider: "github" }]);
    mockGetRecentThreadSummaries.mockResolvedValueOnce([]);

    const inner = fakeModel();
    const wrapped = withMemoryRecall(inner);
    await wrapped.invoke([], { configurable: { userId: "u1" } });

    const calledWith = (inner.invoke as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as BaseMessage[];
    const text = String(calledWith[0]?.content);
    const block = text.slice(
      text.indexOf("<memory>") + "<memory>".length,
      text.indexOf("</memory>"),
    );
    const parsed = JSON.parse(block);
    expect(parsed.session.email).toBe("y@x.com");
    expect(parsed.session.name).toBe("Yongzhuo");
    expect(parsed.socialAccounts).toEqual([{ provider: "github" }]);
  });

  it("does NOT leak accountId / accessToken from the social accounts payload (FR-020)", async () => {
    mockGetProfileDoc.mockResolvedValueOnce({});
    mockGetSession.mockResolvedValueOnce(null);
    mockGetSocialAccounts.mockResolvedValueOnce([{ provider: "github" }]);
    mockGetRecentThreadSummaries.mockResolvedValueOnce([]);

    const inner = fakeModel();
    const wrapped = withMemoryRecall(inner);
    await wrapped.invoke([], { configurable: { userId: "u1" } });

    const calledWith = (inner.invoke as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as BaseMessage[];
    const text = String(calledWith[0]?.content);
    expect(text).not.toContain("accountId");
    expect(text).not.toContain("accessToken");
    expect(text).not.toContain("refreshToken");
  });

  it("session is read fresh on every invoke — no per-process caching (US4 step 3)", async () => {
    mockGetProfileDoc.mockResolvedValue({});
    mockGetRecentThreadSummaries.mockResolvedValue([]);
    mockGetSocialAccounts.mockResolvedValue([]);

    mockGetSession.mockResolvedValueOnce({
      user: { id: "u1", name: "old", email: "y@x.com", image: null },
    });

    const inner = fakeModel();
    const wrapped = withMemoryRecall(inner);
    await wrapped.invoke([], { configurable: { userId: "u1" } });
    let calledWith = (inner.invoke as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as BaseMessage[];
    let block = String(calledWith[0]?.content);
    let parsed = JSON.parse(block.slice(block.indexOf("<memory>") + 8, block.indexOf("</memory>")));
    expect(parsed.session.name).toBe("old");

    mockGetSession.mockResolvedValueOnce({
      user: { id: "u1", name: "new", email: "y@x.com", image: null },
    });

    await wrapped.invoke([], { configurable: { userId: "u1" } });
    calledWith = (inner.invoke as ReturnType<typeof vi.fn>).mock.calls[1]?.[0] as BaseMessage[];
    block = String(calledWith[0]?.content);
    parsed = JSON.parse(block.slice(block.indexOf("<memory>") + 8, block.indexOf("</memory>")));
    expect(parsed.session.name).toBe("new");
  });
});
