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

vi.mock("@/backend/model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/backend/model")>()),
  getChatModel: async () => ({
    withStructuredOutput: () => ({ invoke: mockInvoke }),
  }),
}));

import {
  computeCumulativeWindow,
  stringifyContent,
  threadSummarizeNode,
} from "@/backend/node/thread-summarize-node";

const makeMessages = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    type: "human" as const,
    content: `human-${i}`,
  }));

const CONFIG_OK = { configurable: { userId: "u1", thread_id: "t1" } };

// ponytail: KEEP_RECENT env var defaults to 10 (vs 4 in the prior
// implementation). Tests below pin the new defaults; the
// per-test `process.env` overrides exercise the trigger formula
// edge cases for any non-default value.
const KEEP_RECENT = 10;

describe("computeCumulativeWindow", () => {
  it("returns null when uncompressedCount < KEEP_RECENT (fresh thread, hasn't grown past K yet)", () => {
    // lastEnd=-1 (empty store). humanCount=K-1=9 → uncompressedCount=9 < 10.
    expect(computeCumulativeWindow(9, KEEP_RECENT, -1)).toBeNull();
  });

  it("returns null when between chunks (post-summary, not enough new)", () => {
    // lastEnd=9 (wrote [0..9]). humanCount=15 → uncompressedCount=5 < 10.
    expect(computeCumulativeWindow(15, KEEP_RECENT, 9)).toBeNull();
  });

  it("returns [0..9] on the first trigger (K=10, fresh thread, humanCount ≥ K+1)", () => {
    expect(computeCumulativeWindow(KEEP_RECENT + 1, KEEP_RECENT, -1)).toEqual({
      startIdx: 0,
      endIdx: 9,
    });
  });

  it("returns the next K-sized chunk when enough new content has accumulated", () => {
    // After [0..9] compressed (lastEnd=9), humanCount=21 → next chunk [10..19].
    expect(computeCumulativeWindow(21, KEEP_RECENT, 9)).toEqual({
      startIdx: 10,
      endIdx: 19,
    });
  });

  it("re-emits [0..K-1] after deletion (lastEnd resets to -1)", async () => {
    // User empties Memory tab → store has no summaries → lastEnd=-1 → next
    // trigger re-writes the first chunk instead of continuing from where
    // the deleted entry left off.
    expect(computeCumulativeWindow(KEEP_RECENT + 1, KEEP_RECENT, -1)).toEqual({
      startIdx: 0,
      endIdx: 9,
    });
  });

  it("honors a different KEEP_RECENT (K=3 → K-multiple round-down, store-anchored)", () => {
    // Fresh + too few humans: null.
    expect(computeCumulativeWindow(2, 3, -1)).toBeNull();
    // Fresh + first trigger ready: window [0..2] (3 humans = K).
    expect(computeCumulativeWindow(4, 3, -1)).toEqual({ startIdx: 0, endIdx: 2 });
    // Fresh + more humans (no prior summary): formula rounds DOWN to the
    // largest multiple of K — 7 → 6 humans in window [0..5], not 3.
    // (The "doesn't advance until lastEnd moves" rule only applies once
    // a prior summary has been written; on a fresh store the formula
    // is `uncompressedCount - (uncompressedCount % K) - 1`.)
    expect(computeCumulativeWindow(7, 3, -1)).toEqual({ startIdx: 0, endIdx: 5 });
    // After [0..2] (lastEnd=2), humanCount=7 → next chunk [3..5].
    expect(computeCumulativeWindow(7, 3, 2)).toEqual({ startIdx: 3, endIdx: 5 });
    // Quiet period between chunks: humanCount=5 with lastEnd=2 → uncompressed=2 < K=3 → null.
    expect(computeCumulativeWindow(5, 3, 2)).toBeNull();
    // After [3..5] (lastEnd=5), humanCount=9 → next chunk [6..8].
    expect(computeCumulativeWindow(9, 3, 5)).toEqual({ startIdx: 6, endIdx: 8 });
  });
});

describe("threadSummarizeNode", () => {
  beforeEach(() => {
    mockGetAllUserSummaries.mockReset();
    mockWriteSummary.mockReset();
    mockInvoke.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it("returns no state mutation when userId is missing", async () => {
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

  it("returns no state mutation when userMessageCount < KEEP_RECENT", async () => {
    const out = await threadSummarizeNode({ messages: makeMessages(KEEP_RECENT - 1) }, CONFIG_OK);
    expect(out.messages).toEqual([]);
    expect(mockWriteSummary).not.toHaveBeenCalled();
    expect(mockGetAllUserSummaries).not.toHaveBeenCalled();
  });

  it("fires the first chunk at humanCount == KEEP_RECENT on a fresh thread (gate is < K, not <= K)", async () => {
    // ponytail: gate uses < K (not <= K). With KEEP_RECENT humans on a
    // fresh store, the first trigger fires at humanCount==K, not K+1 —
    // waiting for K+1 stranded users who never send another message,
    // and the round-down formula writes the same [0..K-1] window either
    // way.
    mockGetAllUserSummaries.mockResolvedValue([]);
    mockInvoke.mockResolvedValueOnce({
      entries: [{ question: "Q?", answer: "A.", refs: ["#1-#10"] }],
    });
    mockWriteSummary.mockResolvedValueOnce({});

    const messages = makeMessages(KEEP_RECENT);

    await threadSummarizeNode({ messages }, CONFIG_OK);

    expect(mockWriteSummary).toHaveBeenCalledTimes(1);
    const [, entry] = mockWriteSummary.mock.calls[0];
    expect(entry.endMessageIndex).toBe(KEEP_RECENT - 1);
    expect(entry.messageCount).toBe(KEEP_RECENT);
  });

  it("compresses the first KEEP_RECENT-batch on the first trigger (humanCount = 11)", async () => {
    // ponytail: end-to-end check for requirement 1 (trigger fires) and
    // requirement 4 (compressed-index bookkeeping). First trigger under
    // KEEP_RECENT=10 covers turn 1-10 (humanIdx 0-9).
    mockGetAllUserSummaries.mockResolvedValue([]);
    mockInvoke.mockResolvedValueOnce({
      entries: [{ question: "Q?", answer: "A.", refs: ["#1-#10"] }],
    });
    mockWriteSummary.mockResolvedValueOnce({});

    // 11 humans → first trigger point.
    const messages = makeMessages(11);

    const out = await threadSummarizeNode({ messages }, CONFIG_OK);

    expect(out.messages).toEqual([]); // requirement: messages channel is untouched
    expect(mockWriteSummary).toHaveBeenCalledTimes(1);
    const [, entry] = mockWriteSummary.mock.calls[0];
    expect(entry.startMessageIndex).toBe(0);
    expect(entry.endMessageIndex).toBe(KEEP_RECENT - 1);
    expect(entry.messageCount).toBe(KEEP_RECENT);
    expect(entry.messageIds).toHaveLength(KEEP_RECENT);
    expect(entry.triggerReason).toBe("turn_based");
    expect(entry.tokenCountBefore).toBeGreaterThan(0);
    expect(entry.tokenCountAfter).toBeGreaterThan(0);
  });

  it("skips non-trigger humanCounts without calling LLM or writing", async () => {
    // humanCount=9 < KEEP_RECENT=10 → cheap guard returns before any
    // store read. Node is a no-op.
    const out = await threadSummarizeNode({ messages: makeMessages(9) }, CONFIG_OK);
    expect(out.messages).toEqual([]);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockGetAllUserSummaries).not.toHaveBeenCalled();
    expect(mockWriteSummary).not.toHaveBeenCalled();
  });

  it("skips non-trigger humanCounts when prior summary leaves the gap below K", async () => {
    // Store has prior [0..9] (lastEnd=9). humanCount=15 →
    // uncompressedCount = 15 - 10 = 5 < K=10 → no trigger despite
    // passing the early humanCount <= K gate.
    mockGetAllUserSummaries.mockResolvedValue([{ key: "t1:1", value: makeSummary(1, 0, 9) }]);

    const out = await threadSummarizeNode({ messages: makeMessages(15) }, CONFIG_OK);
    expect(out.messages).toEqual([]);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockGetAllUserSummaries).toHaveBeenCalledTimes(1); // lastCompressedEndIdx only
    expect(mockWriteSummary).not.toHaveBeenCalled();
  });

  it("re-emits the first chunk when prior summaries were deleted from store", async () => {
    // User emptied the Memory tab → store has no entries → lastEnd=-1.
    // Next trigger must re-write [0..9] instead of stalling. Without
    // store-anchored logic this would silently skip and leave humans
    // 0-9 with no summary ever.
    mockGetAllUserSummaries.mockResolvedValue([]);
    mockInvoke.mockResolvedValueOnce({
      entries: [{ question: "q", answer: "a", refs: ["#1-#10"] }],
    });
    mockWriteSummary.mockResolvedValueOnce({});

    const out = await threadSummarizeNode({ messages: makeMessages(KEEP_RECENT + 1) }, CONFIG_OK);

    expect(out.messages).toEqual([]);
    expect(mockWriteSummary).toHaveBeenCalledTimes(1);
    const [, entry] = mockWriteSummary.mock.calls[0];
    expect(entry.startMessageIndex).toBe(0);
    expect(entry.endMessageIndex).toBe(KEEP_RECENT - 1);
    expect(entry.sequence).toBe(1); // fresh thread after deletion
  });

  it("writes incremental sequence numbers for repeat triggers", async () => {
    // ponytail: requirement 2 (incremental compression). At trigger
    // humanCount=21, only KEEP_RECENT=10 new turns fire — turns 0..9
    // already have their own summary.
    mockGetAllUserSummaries.mockResolvedValue([
      { key: "t1:1", value: makeSummary(1, 0, 9) },
      { key: "t2:9", value: makeSummary(9, 0, 0, "t2") }, // other thread — ignored
    ]);
    mockInvoke.mockResolvedValueOnce({
      entries: [{ question: "q", answer: "a", refs: ["#1-#10"] }],
    });
    mockWriteSummary.mockResolvedValueOnce({});

    // 21 humans → second trigger covers humanIdx [10..19].
    await threadSummarizeNode({ messages: makeMessages(21) }, CONFIG_OK);

    const [, entry] = mockWriteSummary.mock.calls[0];
    expect(entry.threadId).toBe("t1");
    expect(entry.sequence).toBe(2); // 1 (existing) + 1 (new)
    expect(entry.startMessageIndex).toBe(10);
    expect(entry.endMessageIndex).toBe(19);
    expect(entry.messageCount).toBe(KEEP_RECENT);
    expect(entry.messageIds).toHaveLength(KEEP_RECENT);
  });

  it("passes a per-turn transcript (one user message per human turn, two text parts each) to the LLM", async () => {
    mockGetAllUserSummaries.mockResolvedValue([]);
    mockInvoke.mockResolvedValueOnce({
      entries: [{ question: "q", answer: "a", refs: ["#1-#10"] }],
    });
    mockWriteSummary.mockResolvedValueOnce({});

    // KEEP_RECENT=10 → first trigger fires at humanCount=11. The
    // per-turn refactor (commit 7072fac) emits one USER message per
    // human turn with two text parts:
    //   part[0] = `This turn ref is ${ref}` (label the LLM must copy)
    //   part[1] = JSON.stringify({ ref, messages: [...] })
    // This way the LLM can attribute each chunk to a specific ref.
    // Labels are GLOBAL humanIndex (1-indexed) so the LLM's refs map
    // 1:1 to the SummaryEntry.startMessageIndex..endMessageIndex range.
    const messages = Array.from({ length: 22 }, (_, i) => ({
      id: `m${i}`,
      type: (i % 2 === 0 ? "human" : "ai") as "human" | "ai",
      content: `turn-${i}`,
    }));

    await threadSummarizeNode({ messages }, CONFIG_OK);

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    // system + N user messages (one per human turn in the window).
    const msgs = mockInvoke.mock.calls[0][0] as Array<{
      role: string;
      content: string | Array<{ type: string; text?: string }>;
    }>;
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("ROLE");
    // KEEP_RECENT=10 → 10 human turns in the window → 10 user messages.
    const userMsgs = msgs.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(10);

    // Each user message has two text parts: the ref label + the JSON body.
    for (let i = 0; i < userMsgs.length; i++) {
      const parts = userMsgs[i].content as Array<{ type: string; text?: string }>;
      expect(Array.isArray(parts)).toBe(true);
      expect(parts).toHaveLength(2);
      expect(parts[0].type).toBe("text");
      expect(parts[0].text).toBe(`This turn ref is #${i + 1}`);
      expect(parts[1].type).toBe("text");
      const body = JSON.parse(parts[1].text!);
      expect(body.ref).toBe(`#${i + 1}`);
      // Each turn is human + AI pair.
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].role).toBe("user");
      expect(body.messages[1].role).toBe("assistant");
    }

    // First turn: turn-0 (user) + turn-1 (assistant)
    const firstParts = userMsgs[0].content as Array<{ type: string; text?: string }>;
    const secondParts = userMsgs[1].content as Array<{ type: string; text?: string }>;
    expect(firstParts[1].text).toContain("turn-0");
    expect(firstParts[1].text).toContain("turn-1");
    // Second turn: turn-2 + turn-3
    expect(secondParts[1].text).toContain("turn-2");
    expect(secondParts[1].text).toContain("turn-3");

    // KEEP_RECENT=10 cuts at the 10th human; positions 20/21 belong to
    // the 11th human + its AI reply and must not leak into this chunk.
    const allTexts = userMsgs
      .map((m) => (m.content as Array<{ text?: string }>).map((p) => p.text ?? "").join("\n"))
      .join("\n");
    expect(allTexts).not.toContain("turn-20");
    expect(allTexts).not.toContain("turn-21");
  });

  it("captures the AI reply following the last human in the window (no orphan questions)", async () => {
    // KEEP_RECENT=10 + humanCount=11 → window [0..9]. The earlier bug:
    // sliceEnd = humanIndices[9] = position 18 which IS the 10th human
    // itself — so turn-19 (the AI reply to the 10th user) was dropped,
    // leaving the last JSONL entry as a Q with no A. Fix: extend the
    // slice past the last human to the next human (or messages.length
    // when endIdx is the last human) so the trailing AI/tool land in
    // the same JSONL entry.
    mockGetAllUserSummaries.mockResolvedValue([]);
    mockInvoke.mockResolvedValueOnce({
      entries: [{ question: "q", answer: "a", refs: ["#1-#10"] }],
    });
    mockWriteSummary.mockResolvedValueOnce({});

    const messages = Array.from({ length: 22 }, (_, i) => ({
      id: `m${i}`,
      type: (i % 2 === 0 ? "human" : "ai") as "human" | "ai",
      content: `turn-${i}`,
    }));

    await threadSummarizeNode({ messages }, CONFIG_OK);

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const msgs = mockInvoke.mock.calls[0][0] as Array<{
      role: string;
      content: string | Array<{ type: string; text?: string }>;
    }>;
    const userMsgs = msgs.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(10);

    // The 10th (last) user message MUST carry BOTH turn-18 (Q10) and
    // turn-19 (A10) — otherwise the LLM sees a Q with no A. Per-turn
    // refactor reads them from the same ThreadLine.messages[].
    const lastUserMsg = userMsgs[9];
    const lastParts = lastUserMsg.content as Array<{ type: string; text?: string }>;
    const lastBody = JSON.parse(lastParts[1].text!);
    expect(lastBody.ref).toBe("#10");
    expect(lastBody.messages).toHaveLength(2);
    expect(lastBody.messages[0].role).toBe("user");
    expect(lastBody.messages[0].content).toBe("turn-18");
    expect(lastBody.messages[1].role).toBe("assistant");
    expect(lastBody.messages[1].content).toBe("turn-19");

    // The 11th pair must still not leak.
    const allTexts = userMsgs
      .map((m) => (m.content as Array<{ text?: string }>).map((p) => p.text ?? "").join("\n"))
      .join("\n");
    expect(allTexts).not.toContain("turn-20");
    expect(allTexts).not.toContain("turn-21");
  });

  it("uses the store anchor as the #N offset on later chunks (refs map to SummaryEntry range)", async () => {
    // After [0..9] is already compressed (lastEnd=9), the next trigger
    // at humanCount=21 covers [10..19] and the per-turn labels MUST be
    // #11..#20 (1-indexed + offset 10), NOT #1..#10. Otherwise the LLM's
    // refs would point at the wrong SummaryEntry range — the whole point
    // of the global-index fix.
    mockGetAllUserSummaries.mockResolvedValue([{ key: "t1:1", value: makeSummary(1, 0, 9) }]);
    mockInvoke.mockResolvedValueOnce({
      entries: [{ question: "q", answer: "a", refs: ["#11-#20"] }],
    });
    mockWriteSummary.mockResolvedValueOnce({});

    const messages = Array.from({ length: 42 }, (_, i) => ({
      id: `m${i}`,
      type: (i % 2 === 0 ? "human" : "ai") as "human" | "ai",
      content: `turn-${i}`,
    }));

    await threadSummarizeNode({ messages }, CONFIG_OK);

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    // 10 user messages for the 10 humans in [10..19]. Labels #11..#20.
    const msgs = mockInvoke.mock.calls[0][0] as Array<{
      role: string;
      content: string | Array<{ type: string; text?: string }>;
    }>;
    const userMsgs = msgs.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(10);

    // Per-turn ref label = `This turn ref is #N`, the JSON body has `id: #N`.
    const firstParts = userMsgs[0].content as Array<{ type: string; text?: string }>;
    expect(firstParts[0].text).toBe("This turn ref is #11");
    const firstBody = JSON.parse(firstParts[1].text!);
    expect(firstBody.ref).toBe("#11");
    expect(firstBody.messages).toHaveLength(2);
    expect(firstBody.messages[0].role).toBe("user");
    expect(firstBody.messages[0].content).toBe("turn-20");
    expect(firstBody.messages[1].role).toBe("assistant");
    expect(firstBody.messages[1].content).toBe("turn-21");

    const secondParts = userMsgs[1].content as Array<{ type: string; text?: string }>;
    expect(secondParts[0].text).toBe("This turn ref is #12");
    const secondBody = JSON.parse(secondParts[1].text!);
    expect(secondBody.ref).toBe("#12");
    expect(secondBody.messages[0].content).toBe("turn-22");
    expect(secondBody.messages[1].content).toBe("turn-23");

    // Old range [0..9] is gone — labels #1..#10 must not appear.
    const allTexts = userMsgs
      .map((m) => (m.content as Array<{ text?: string }>).map((p) => p.text ?? "").join("\n"))
      .join("\n");
    expect(allTexts).not.toMatch(/"ref":"#1"/);
    expect(allTexts).not.toMatch(/"ref":"#10"/);
  });

  it("invokes the LLM with the nostream tag", async () => {
    mockGetAllUserSummaries.mockResolvedValue([]);
    mockInvoke.mockResolvedValueOnce({
      entries: [{ question: "q", answer: "a", refs: ["#1"] }],
    });
    mockWriteSummary.mockResolvedValueOnce({});

    await threadSummarizeNode({ messages: makeMessages(11) }, CONFIG_OK);

    const opts = mockInvoke.mock.calls[0][1] as { tags?: string[] };
    expect(opts.tags).toContain("nostream");
  });

  it("returns no mutation when LLM emits empty entries", async () => {
    mockGetAllUserSummaries.mockResolvedValue([]);
    mockInvoke.mockResolvedValueOnce({ entries: [] });
    mockWriteSummary.mockResolvedValueOnce({});

    const out = await threadSummarizeNode({ messages: makeMessages(11) }, CONFIG_OK);
    expect(out.messages).toEqual([]);
    expect(mockWriteSummary).not.toHaveBeenCalled();
  });

  it("swallows LLM failures with console.warn — no state mutation, no throw", async () => {
    // ponytail: bg-agent failures must NEVER throw. A failed pass means
    // one missed trigger point; the next turn re-fires the same window
    // (stateless formula). Throwing would crash the background agent
    // and leave every later dispatch dead.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGetAllUserSummaries.mockResolvedValue([]);
    mockInvoke.mockRejectedValueOnce(new Error("boom"));

    const out = await threadSummarizeNode({ messages: makeMessages(11) }, CONFIG_OK);

    expect(out.messages).toEqual([]);
    expect(mockWriteSummary).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain("LLM call failed");
    warnSpy.mockRestore();
  });

  it("never mutates state.messages (requirement: original turns preserved)", async () => {
    // requirement: 3 — summary data sits in the <threads> block of the
    // chatAgent's system prompt (built at invoke time from the store),
    // NOT in the messages channel. The node's only return value is
    // `{ messages: [] }` — the empty update keeps the channel pristine.
    mockGetAllUserSummaries.mockResolvedValue([]);
    mockInvoke.mockResolvedValueOnce({ entries: [{ question: "q", answer: "a", refs: ["#1"] }] });
    mockWriteSummary.mockResolvedValueOnce({});

    const out = await threadSummarizeNode({ messages: makeMessages(11) }, CONFIG_OK);
    expect(out.messages).toEqual([]);
    expect(out.messages).not.toContain(expect.objectContaining({ role: "system" }));
  });
});

function makeSummary(
  sequence: number,
  start: number,
  end: number,
  threadId = "t1",
): {
  threadId: string;
  sequence: number;
  startMessageIndex: number;
  endMessageIndex: number;
  messageCount: number;
  messageIds: string[];
  summary: string;
  triggerReason: "turn_based";
  tokenCountBefore: number;
  tokenCountAfter: number;
  createdAt: string;
} {
  return {
    threadId,
    sequence,
    startMessageIndex: start,
    endMessageIndex: end,
    messageCount: end - start + 1,
    messageIds: Array.from({ length: end - start + 1 }, (_, i) => `prev-${i}`),
    summary: "prior summary",
    triggerReason: "turn_based",
    tokenCountBefore: 0,
    tokenCountAfter: 0,
    createdAt: new Date().toISOString(),
  };
}

describe("stringifyContent", () => {
  it("returns a plain string as-is", () => {
    expect(stringifyContent("hello")).toBe("hello");
  });

  it("joins multiple text parts with spaces", () => {
    expect(
      stringifyContent([
        { type: "text", text: "这是谁" },
        { type: "text", text: "?" },
      ]),
    ).toBe("这是谁 ?");
  });

  it("renders image_url as a [image: <url>] marker so the LLM knows an image was attached", () => {
    // Regression: previously the function dropped any part without a `text`
    // field, so an image attachment disappeared from the summarize
    // transcript and the LLM had no idea the user sent an image.
    const out = stringifyContent([
      { type: "text", text: "这是谁" },
      { type: "image_url", image_url: { url: "https://file.example/x.jpg" } },
    ]);
    expect(out).toContain("这是谁");
    expect(out).toMatch(/\[image:\s*https:\/\/file\.example\/x\.jpg\]/);
  });

  it("renders a LangChain-style image part the same way (image: <value>)", () => {
    expect(stringifyContent([{ type: "image", image: "https://x/y.png" }])).toBe(
      "[image: https://x/y.png]",
    );
  });

  it("renders file parts as [file: <name>] when a filename is present", () => {
    expect(
      stringifyContent([{ type: "file", data: "https://x/y.pdf", filename: "report.pdf" }]),
    ).toBe("[file: report.pdf]");
  });

  it("renders file parts as [file: <data>] when no filename is set", () => {
    expect(stringifyContent([{ type: "file", data: "https://x/y.pdf" }])).toBe(
      "[file: https://x/y.pdf]",
    );
  });

  it("does not drop unknown parts — falls back to a JSON one-liner", () => {
    expect(stringifyContent([{ type: "audio", audio: { url: "https://x/y.mp3" } }])).toBe(
      '{"type":"audio","audio":{"url":"https://x/y.mp3"}}',
    );
  });

  it("returns empty string for null / undefined", () => {
    expect(stringifyContent(null)).toBe("");
    expect(stringifyContent(undefined)).toBe("");
  });

  it("JSON-stringifies non-array objects", () => {
    expect(stringifyContent({ foo: 1 })).toBe('{"foo":1}');
  });
});
