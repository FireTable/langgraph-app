import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetAllUserSummaries, mockWriteSummary, mockInvoke } = vi.hoisted(() => ({
  mockGetAllUserSummaries: vi.fn(),
  mockWriteSummary: vi.fn(),
  mockInvoke: vi.fn(),
}));

vi.mock("@/lib/memory/queries", () => ({
  getAllUserSummaries: mockGetAllUserSummaries,
  writeSummary: mockWriteSummary,
}));

vi.mock("@/backend/model", () => ({
  chatModel: {
    withStructuredOutput: () => ({ invoke: mockInvoke }),
  },
}));

vi.mock("@/backend/store", () => ({ store: {} }));

import { threadSummarizeNode } from "@/backend/node/thread-summarize-node";

const makeMessages = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ type: "human" as const, content: `m${i}` }));

describe("threadSummarizeNode (FR-009..012)", () => {
  beforeEach(() => {
    mockGetAllUserSummaries.mockReset();
    mockWriteSummary.mockReset();
    mockInvoke.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it("skips when userMessageCount <= THRESHOLD (default 10)", async () => {
    const out = await threadSummarizeNode(
      { messages: makeMessages(5) },
      { configurable: { userId: "u1", thread_id: "t1" } },
    );
    expect(out).toEqual({});
    expect(mockWriteSummary).not.toHaveBeenCalled();
  });

  it("computes startIdx=0, endIdx=userMessageCount-KEEP_RECENT (closed interval; no prior summary)", async () => {
    // FR-010: userMessageCount=11, KEEP_RECENT=4 → endIdx = 11 - 4 = 7.
    // Closed window [0..7] = 8 messages. messageCount = 8.
    mockGetAllUserSummaries.mockResolvedValueOnce([]);
    mockInvoke.mockResolvedValueOnce({ name: "intro", description: "met" });
    mockWriteSummary.mockResolvedValueOnce({});

    await threadSummarizeNode(
      { messages: makeMessages(11) },
      { configurable: { userId: "u1", thread_id: "t1" } },
    );

    expect(mockWriteSummary).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({
        threadId: "t1",
        sequence: 1,
        startMessageIndex: 0,
        endMessageIndex: 7,
        messageCount: 8,
      }),
    );
  });

  it("skips when endIdx < startIdx (closed-interval zero window)", async () => {
    // userMessageCount=11 with prior at endMessageIndex=10:
    // startIdx=11, endIdx=7 → 11 < 7 is false, 11 <= 7 is false, but
    // endIdx(7) < startIdx(11) is true → SKIP. The constant KEEP_RECENT=4
    // and latest covering msgs 0..10 means there are no messages
    // between startIdx and endIdx to summarize.
    mockGetAllUserSummaries.mockResolvedValueOnce([
      { key: "t1:1", value: makeSummary("t1", 1, 0, 10) },
    ]);

    const out = await threadSummarizeNode(
      { messages: makeMessages(11) },
      { configurable: { userId: "u1", thread_id: "t1" } },
    );
    expect(out).toEqual({});
    expect(mockWriteSummary).not.toHaveBeenCalled();
  });

  it("computes 1-message window (startIdx === endIdx)", async () => {
    // prior covers 0..9; startIdx = 10; endIdx = 11 - 4 = 7. Skip
    //   → we need a larger userMessageCount. userMessageCount=15,
    //   prior at 0..13 → startIdx=14, endIdx=15-4=11 → skip.
    // The 1-message window only lands when latest.endMessageIndex is
    // exactly endIdx-1 (KEEP_RECENT=N, count = latestEnd + N + 1):
    //   latest.endMessageIndex=6, count=11 → startIdx=7, endIdx=7.
    mockGetAllUserSummaries.mockResolvedValueOnce([
      { key: "t1:1", value: makeSummary("t1", 1, 0, 6) },
    ]);
    mockInvoke.mockResolvedValueOnce({ name: "n", description: "d" });
    mockWriteSummary.mockResolvedValueOnce({});

    await threadSummarizeNode(
      { messages: makeMessages(11) },
      { configurable: { userId: "u1", thread_id: "t1" } },
    );

    expect(mockWriteSummary).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({
        sequence: 2,
        startMessageIndex: 7,
        endMessageIndex: 7,
        messageCount: 1,
      }),
    );
  });

  it("computes 2-message window (startIdx + 1 === endIdx)", async () => {
    // latest at 0..5; startIdx = 6, endIdx = 12 - 4 = 8. Window is [6..8] = 3
    //   messages. For 2: latest at 0..5, userMessageCount = 11 → endIdx = 7,
    //   startIdx = 6 → [6..7] = 2 messages.
    mockGetAllUserSummaries.mockResolvedValueOnce([
      { key: "t1:1", value: makeSummary("t1", 1, 0, 5) },
    ]);
    mockInvoke.mockResolvedValueOnce({ name: "n", description: "d" });
    mockWriteSummary.mockResolvedValueOnce({});

    await threadSummarizeNode(
      { messages: makeMessages(11) },
      { configurable: { userId: "u1", thread_id: "t1" } },
    );

    expect(mockWriteSummary).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({
        sequence: 2,
        startMessageIndex: 6,
        endMessageIndex: 7,
        messageCount: 2,
      }),
    );
  });

  it("uses last summary's endMessageIndex as the next startIdx (incremental)", async () => {
    // prior at end=6; userMessageCount=16 → endIdx=12; startIdx=7;
    // messageCount = 12 - 7 + 1 = 6.
    mockGetAllUserSummaries.mockResolvedValueOnce([
      { key: "t1:1", value: makeSummary("t1", 1, 0, 6) },
    ]);
    mockInvoke.mockResolvedValueOnce({ name: "followup", description: "after" });
    mockWriteSummary.mockResolvedValueOnce({});

    await threadSummarizeNode(
      { messages: makeMessages(16) },
      { configurable: { userId: "u1", thread_id: "t1" } },
    );

    expect(mockWriteSummary).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({
        sequence: 2,
        startMessageIndex: 7,
        endMessageIndex: 12,
        messageCount: 6,
      }),
    );
  });

  it("skips when userId is missing (no writes)", async () => {
    const out = await threadSummarizeNode(
      { messages: makeMessages(20) },
      { configurable: { thread_id: "t1" } },
    );
    expect(out).toEqual({});
    expect(mockWriteSummary).not.toHaveBeenCalled();
  });

  it("skips when thread_id is missing", async () => {
    const out = await threadSummarizeNode(
      { messages: makeMessages(20) },
      { configurable: { userId: "u1" } },
    );
    expect(out).toEqual({});
    expect(mockWriteSummary).not.toHaveBeenCalled();
  });
});

function makeSummary(threadId: string, sequence: number, start: number, end: number) {
  return {
    threadId,
    sequence,
    name: "n",
    description: "d",
    startMessageIndex: start,
    endMessageIndex: end,
    messageCount: end - start + 1,
    updatedAt: new Date().toISOString(),
  };
}
