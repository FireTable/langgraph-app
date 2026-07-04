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

// ponytail: shouldSummarizeRouter used to live in backend/agent.ts as
// the conditional edge function that gated threadSummarizeNode.
// With the B-path refactor it was deleted — the gate is now re-derived
// inside threadSummarizeNode itself (defensive only; chat graph no
// longer has a fan-out at all). The describe block that used to cover
// shouldSummarizeRouter was removed in the same change. Tests below
// cover the node's "caught-up" branch directly instead.

import { threadSummarizeNode } from "@/backend/node/thread-summarize-node";

const makeMessages = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    type: "human" as const,
    content: `human-${i}`,
  }));

const CONFIG_OK = { configurable: { userId: "u1", thread_id: "t1" } };

describe("threadSummarizeNode (FR-009..012)", () => {
  beforeEach(() => {
    mockGetAllUserSummaries.mockReset();
    mockWriteSummary.mockReset();
    mockInvoke.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it("returns no state mutation when userId is missing (defensive — router should have END'd)", async () => {
    const out = await threadSummarizeNode(
      { messages: makeMessages(20) },
      { configurable: { thread_id: "t1" } },
    );
    expect(out.messages).toEqual([]);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockWriteSummary).not.toHaveBeenCalled();
  });

  it("returns no state mutation when thread_id is missing", async () => {
    const out = await threadSummarizeNode(
      { messages: makeMessages(20) },
      { configurable: { userId: "u1" } },
    );
    expect(out.messages).toEqual([]);
    expect(mockWriteSummary).not.toHaveBeenCalled();
  });

  it("returns no state mutation when userMessageCount ≤ KEEP_RECENT", async () => {
    const out = await threadSummarizeNode({ messages: makeMessages(4) }, CONFIG_OK);
    expect(out.messages).toEqual([]);
    expect(mockWriteSummary).not.toHaveBeenCalled();
  });

  it("compresses a default batch (6 turns) with no prior summary — does NOT touch the messages channel", async () => {
    // ponytail: the original messages stay in the channel; the summary
    // is written to the store only. Removing turns would erase
    // user-visible history, and injecting a synthetic HumanMessage
    // would render in the chat as a phantom user turn — both
    // rejected during review, so the node is now side-effect-only.
    mockGetAllUserSummaries.mockResolvedValueOnce([]);
    mockInvoke.mockResolvedValueOnce({
      entries: [{ question: "Q?", answer: "A.", refs: ["#1-#11"] }],
    });
    mockWriteSummary.mockResolvedValueOnce({});

    const messages = Array.from({ length: 22 }, (_, i) => ({
      id: `m${i}`,
      type: (i % 2 === 0 ? "human" : "ai") as "human" | "ai",
      content: `turn-${i}`,
    }));

    const out = await threadSummarizeNode({ messages }, CONFIG_OK);

    // State mutation: empty. The 11 original messages stay in the channel.
    expect(out.messages).toEqual([]);

    // writeSummary is called once with the Q&A text + human id map
    // (parallel to messageCount: 6 humans in [0..10]).
    expect(mockWriteSummary).toHaveBeenCalledTimes(1);
    const [, entry] = mockWriteSummary.mock.calls[0];
    expect(entry.summary).toContain("Q: Q?");
    expect(entry.summary).toContain("A: A.");
    expect(entry.messageIds).toEqual(["m0", "m2", "m4", "m6", "m8", "m10"]);
    expect(entry.messageCount).toBe(6);
  });

  it("uses human-turn boundaries — N humans + interleaved AI/tool → N Q&As in the SummaryEntry", async () => {
    // ponytail: the batch boundary is HUMAN turns, not raw messages.
    // BATCH_SIZE=6 means 6 human turns per batch — the excerpt
    // extends over every AI/tool reply between the first and last
    // human in the window. Each human turn maps to one Q&A; the
    // interleaved AI/tool calls are absorbed into the human's
    // corresponding Q&A (the LLM does the grouping, the program
    // only does id-mapping).
    mockGetAllUserSummaries.mockResolvedValueOnce([]);
    // 6 humans in the window → 6 Q&A entries, each spanning one
    // human turn + its AI/tool replies.
    mockInvoke.mockResolvedValueOnce({
      entries: Array.from({ length: 6 }, (_, i) => ({
        question: `q-${i + 1}`,
        answer: `a-${i + 1}`,
        refs: [`#${i * 3 + 1}-#${i * 3 + 3}`],
      })),
    });
    mockWriteSummary.mockResolvedValueOnce({});

    // Each human turn interleaved with 1 AI reply + 1 tool call →
    // 3 messages per human. 11 humans total = 33 messages.
    // BATCH_SIZE=6, KEEP_RECENT=4 → window [0..5] in the human-only
    // sequence = 6 humans. Excerpt covers messages[0..15] = 16 raw
    // messages (6 humans + 5 AI + 5 tool).
    //
    // messages[i] for i in [0..15] maps to #i+1 in the transcript:
    //   #1=h0, #2=a0, #3=t0, #4=h1, #5=a1, #6=t1, ..., #15=t4, #16=h5
    const messages = [];
    for (let i = 0; i < 11; i++) {
      messages.push({ id: `h${i}`, type: "human" as const, content: `human-${i}` });
      messages.push({ id: `a${i}`, type: "ai" as const, content: `ai-${i}` });
      messages.push({ id: `t${i}`, type: "tool" as const, content: `tool-${i}` });
    }

    const out = await threadSummarizeNode({ messages }, CONFIG_OK);

    // Channel is left alone.
    expect(out.messages).toEqual([]);

    // Transcript sent to LLM spans #1..#16 — proves the excerpt
    // captured every interleaved AI/tool reply, not just humans.
    const msgs = mockInvoke.mock.calls[0][0] as Array<{
      role: string;
      content: string;
    }>;
    const transcript = msgs[1].content;
    expect(transcript).toContain("#1 User: human-0");
    expect(transcript).toContain("#2 Assistant: ai-0");
    expect(transcript).toContain("#3 Tool: tool-0");
    expect(transcript).toContain("#4 User: human-1");
    // 16 = 6 humans (at odd positions 1,4,7,10,13,16) + 5 AI (at
    // 2,5,8,11,14) + 5 tool (at 3,6,9,12,15). Last entry is human-5.
    expect(transcript).toMatch(/#16 User: human-5/);
    // Window doesn't leak into KEEP_RECENT territory.
    expect(transcript).not.toContain("human-6");
    expect(transcript).not.toContain("#17");

    // SummaryEntry carries all 6 Q&As through to the store + the
    // human-only id map (parallel to messageCount).
    expect(mockWriteSummary).toHaveBeenCalledTimes(1);
    const [, entry] = mockWriteSummary.mock.calls[0];
    for (let i = 1; i <= 6; i++) {
      expect(entry.summary).toContain(`q-${i}`);
      expect(entry.summary).toContain(`a-${i}`);
    }
    expect(entry.messageIds).toEqual(["h0", "h1", "h2", "h3", "h4", "h5"]);
    expect(entry.messageCount).toBe(6);
    expect(entry.startMessageIndex).toBe(0);
    expect(entry.endMessageIndex).toBe(5);
  });

  it("writes a SummaryEntry with sequence, indices, messageIds, and the formatted Q&A text", async () => {
    mockGetAllUserSummaries.mockResolvedValueOnce([]);
    mockInvoke.mockResolvedValueOnce({
      entries: [{ question: "what now", answer: "we did X", refs: ["#1-#2"] }],
    });
    mockWriteSummary.mockResolvedValueOnce({});

    await threadSummarizeNode({ messages: makeMessages(11) }, CONFIG_OK);

    expect(mockWriteSummary).toHaveBeenCalledTimes(1);
    const [userIdArg, entry] = mockWriteSummary.mock.calls[0];
    expect(userIdArg).toBe("u1");
    expect(entry).toMatchObject({
      threadId: "t1",
      sequence: 1,
      startMessageIndex: 0,
      endMessageIndex: 5, // closed, 6 turns (0..5)
      messageCount: 6,
      messageIds: ["m0", "m1", "m2", "m3", "m4", "m5"],
    });
    expect(entry.summary).toContain("Q: what now");
    expect(entry.summary).toContain("A: we did X");
  });

  it("writes sequence + 1 when a prior summary for this thread exists (incremental)", async () => {
    mockGetAllUserSummaries.mockResolvedValueOnce([
      { key: "t1:1", value: makeSummary(1, 0, 5) },
      { key: "t1:2", value: makeSummary(2, 6, 11) },
      { key: "t2:9", value: makeSummary(9, 0, 0, "t2") }, // other thread — ignored
    ]);
    mockInvoke.mockResolvedValueOnce({
      entries: [{ question: "q", answer: "a", refs: ["#1-#1"] }],
    });
    mockWriteSummary.mockResolvedValueOnce({});

    // 18 humans: BATCH_SIZE=6, KEEP_RECENT=4, startIdx=12 (lastEnd+1),
    // maxEndIdx = 18 - 4 - 1 = 13, idealEndIdx = 12 + 5 = 17 → endIdx = 13.
    // Window [12..13] = 2 turns.
    await threadSummarizeNode({ messages: makeMessages(18) }, CONFIG_OK);

    const [, entry] = mockWriteSummary.mock.calls[0];
    expect(entry).toMatchObject({
      threadId: "t1",
      sequence: 3, // picked the highest seq for t1 (2) + 1
      startMessageIndex: 12,
      endMessageIndex: 13,
      messageCount: 2,
    });
  });

  it("returns no mutation when prior summary already covers the entire summarizable range", async () => {
    // ponytail: endIdx < startIdx is the "caught up" case. We don't
    // want to call the LLM just to produce an empty summary.
    mockGetAllUserSummaries.mockResolvedValueOnce([{ key: "t1:1", value: makeSummary(1, 0, 6) }]);
    const out = await threadSummarizeNode({ messages: makeMessages(10) }, CONFIG_OK);
    expect(out.messages).toEqual([]);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockWriteSummary).not.toHaveBeenCalled();
  });

  it("passes a transcript of #N-labeled turns to the LLM (system + user)", async () => {
    mockGetAllUserSummaries.mockResolvedValueOnce([]);
    mockInvoke.mockResolvedValueOnce({
      entries: [{ question: "q", answer: "a", refs: ["#1-#4"] }],
    });
    mockWriteSummary.mockResolvedValueOnce({});

    // 6 human + 6 ai turns → 12 messages. Window covers the first 7
    // humans (BATCH_SIZE=6, KEEP_RECENT=4, no prior → startIdx=0,
    // endIdx=5, plus one ai at index humanIndices[5]+1? Actually we
    // include everything up to and including humanIndices[5]). Map:
    // humanIndices[0..5] are at positions [0, 2, 4, 6, 8, 10]. So the
    // excerpt is messages[0..10] = 11 messages (6 human + 5 ai in
    // between; the assistant at humanIndices[5]'s row is NOT included
    // because there's no ai after position 10).
    const messages = Array.from({ length: 12 }, (_, i) => ({
      id: `m${i}`,
      type: (i % 2 === 0 ? "human" : "ai") as "human" | "ai",
      content: `turn-${i}`,
    }));

    await threadSummarizeNode({ messages }, CONFIG_OK);

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const callArgs = mockInvoke.mock.calls[0];
    const msgs = callArgs[0] as Array<{ role: string; content: string }>;
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("compressing a slice");
    expect(msgs[1].role).toBe("user");
    const transcript = msgs[1].content;
    expect(transcript).toContain("#1 User: turn-0");
    expect(transcript).toContain("#2 Assistant: turn-1");
    // The transcript omits recent + already-summarized turns.
    expect(transcript).not.toContain("#12");
    expect(transcript).not.toContain("turn-11");
  });

  it("invokes the LLM with the nostream tag so partial tokens don't leak into the chat stream", async () => {
    mockGetAllUserSummaries.mockResolvedValueOnce([]);
    mockInvoke.mockResolvedValueOnce({
      entries: [{ question: "q", answer: "a", refs: ["#1"] }],
    });
    mockWriteSummary.mockResolvedValueOnce({});

    await threadSummarizeNode({ messages: makeMessages(11) }, CONFIG_OK);

    const opts = mockInvoke.mock.calls[0][1] as { tags?: string[] };
    expect(opts.tags).toContain("nostream");
  });

  it("returns no mutation when the LLM emits an empty entries list (no save)", async () => {
    mockGetAllUserSummaries.mockResolvedValueOnce([]);
    mockInvoke.mockResolvedValueOnce({ entries: [] });
    mockWriteSummary.mockResolvedValueOnce({});

    const out = await threadSummarizeNode({ messages: makeMessages(11) }, CONFIG_OK);

    expect(out.messages).toEqual([]);
    expect(mockWriteSummary).not.toHaveBeenCalled();
  });
});

function makeSummary(sequence: number, start: number, end: number, threadId = "t1") {
  return {
    threadId,
    sequence,
    name: "n",
    description: "d",
    startMessageIndex: start,
    endMessageIndex: end,
    messageCount: end - start + 1,
    messageIds: Array.from({ length: end - start + 1 }, (_, i) => `prev-${i}`),
    summary: "prior summary",
    updatedAt: new Date().toISOString(),
  };
}
