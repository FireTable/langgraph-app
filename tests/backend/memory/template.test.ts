import { describe, it, expect, vi, afterEach } from "vitest";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  createSystemPromptWithMemoryTemplate,
  loadThreadSummariesForPrompt,
  prepareMessagesForInvoke,
  type ThreadSummariesPayload,
} from "@/backend/memory/template";
import * as queries from "@/lib/memory/queries";
import * as recall from "@/backend/memory/recall";

describe("createSystemPromptWithMemoryTemplate", () => {
  it("returns a SystemMessage with the base prompt when memory is null", async () => {
    const msg = await createSystemPromptWithMemoryTemplate("You are helpful.", null, null);
    expect(msg).toBeInstanceOf(SystemMessage);
    expect(msg.content).toBe("You are helpful.");
  });

  it("appends a <memory> block when memory is provided", async () => {
    const payload = { memory: { role: "backend" } };
    const msg = await createSystemPromptWithMemoryTemplate("You are helpful.", payload, null);
    const text = String(msg.content);
    expect(text).toContain("You are helpful.");
    expect(text).toContain("<memory>");
    expect(text).toContain("backend");
    expect(text).toContain("</memory>");
  });

  it("appends an <earlier_conversation> block when thread summaries are provided", async () => {
    const threads = {
      threadId: "t1",
      summaries: [
        {
          sequence: 1,
          summary: { entries: [{ question: "hello", answer: "world", refs: ["1"] }] },
          startMessageIndex: 0,
          endMessageIndex: 9,
          triggerReason: "turn_based" as const,
          tokenCountBefore: 80,
          tokenCountAfter: 12,
          createdAt: "2026-07-06T00:00:00.000Z",
        },
      ],
    };
    const msg = await createSystemPromptWithMemoryTemplate("base", null, threads);
    const text = String(msg.content);
    expect(text).toContain("<earlier_conversation>");
    expect(text).toContain("</earlier_conversation>");
    expect(text).toContain("hello");
    expect(text).toContain("Earlier in this conversation");
  });

  it("renders <earlier_conversation> with formatted Q&A prose — not raw JSON", async () => {
    // ponytail: the LLM-facing <earlier_conversation> block uses the
    // SAME formatter as the Memory tab UI (formatSummaryText). Drift
    // would silently change what the model sees vs what the user sees
    // — pin the exact shape here.
    const threads = {
      threadId: "t1",
      summaries: [
        {
          sequence: 1,
          summary: {
            entries: [
              { question: "hello", answer: "world", refs: ["1"] },
              { question: "follow-up", answer: "second", refs: ["2"] },
            ],
          },
          startMessageIndex: 0,
          endMessageIndex: 9,
          triggerReason: "turn_based" as const,
          tokenCountBefore: 80,
          tokenCountAfter: 18,
          createdAt: "2026-07-06T00:00:00.000Z",
        },
        {
          sequence: 2,
          summary: { entries: [{ question: "next", answer: "answer", refs: ["10"] }] },
          startMessageIndex: 10,
          endMessageIndex: 19,
          triggerReason: "turn_based" as const,
          tokenCountBefore: 80,
          tokenCountAfter: 9,
          createdAt: "2026-07-06T01:00:00.000Z",
        },
      ],
    };
    const msg = await createSystemPromptWithMemoryTemplate("base", null, threads);
    const text = String(msg.content);

    // Extract everything between <earlier_conversation>…</earlier_conversation>
    const inside = text
      .slice(
        text.indexOf("<earlier_conversation>\n") + "<earlier_conversation>\n".length,
        text.indexOf("</earlier_conversation>"),
      )
      .trimEnd();
    expect(inside).toContain(
      [
        "#1",
        "Q: hello",
        "A: world",
        "",
        "#2",
        "Q: follow-up",
        "A: second",
        "",
        "#10",
        "Q: next",
        "A: answer",
      ].join("\n"),
    );
    expect(inside).toContain("lookup_thread_messages");

    // Negative: no `---` separator, no raw-JSON keys.
    expect(inside).not.toContain("---");
    expect(inside).not.toContain('"entries"');
    expect(inside).not.toContain('"question"');
    expect(inside).not.toContain('"answer"');
    expect(inside).not.toContain('"refs"');
  });

  it("does NOT render an <earlier_conversation> block when summaries is empty / null", async () => {
    const msg = await createSystemPromptWithMemoryTemplate("base", null, null);
    const text = String(msg.content);
    expect(text).not.toContain("<earlier_conversation>");
  });

  it("does not include a <memory> block when memory is null", async () => {
    const msg = await createSystemPromptWithMemoryTemplate("You are helpful.", null, null);
    expect(String(msg.content)).not.toContain("<memory>");
  });

  it("omits both blocks when memory is empty", async () => {
    return createSystemPromptWithMemoryTemplate(
      "base",
      { memory: {} },
      { threadId: "t1", summaries: [] },
    ).then((msg) => {
      expect(String(msg.content)).not.toContain("<memory>");
      expect(String(msg.content)).not.toContain("<threads>");
    });
  });

  it("preserves base prompt verbatim including newlines and special chars", async () => {
    const base = "Line 1\nLine 2 — with em-dash & ampersand";
    const msg = await createSystemPromptWithMemoryTemplate(base, null, null);
    expect(String(msg.content)).toBe(base);
  });

  it("serializes memory as pretty-printed JSON for readability", async () => {
    const payload = { memory: { a: 1, b: 2 } };
    const msg = await createSystemPromptWithMemoryTemplate("base", payload, null);
    const text = String(msg.content);
    expect(text).toContain('"a": 1');
    expect(text).toContain('"b": 2');
  });

  it("renders <save_memory_rule> inside <memory> when memory is present", async () => {
    const payload = { memory: { role: "backend" } };
    const msg = await createSystemPromptWithMemoryTemplate("base", payload, null);
    const text = String(msg.content);
    expect(text).toContain("<save_memory_rule>");
    expect(text).toContain("</save_memory_rule>");
    const memoryOpen = text.indexOf("<memory>");
    const ruleOpen = text.indexOf("<save_memory_rule>");
    const memoryClose = text.indexOf("</memory>");
    expect(memoryOpen).toBeGreaterThan(-1);
    expect(ruleOpen).toBeGreaterThan(memoryOpen);
    expect(memoryClose).toBeGreaterThan(ruleOpen);
  });

  it("wraps {{memoryJson}} in <memory_json> tag inside <memory>", async () => {
    const payload = { memory: { role: "backend" } };
    const msg = await createSystemPromptWithMemoryTemplate("base", payload, null);
    const text = String(msg.content);
    const memoryOpen = text.indexOf("<memory>");
    const tagOpen = text.indexOf("<memory_json>");
    const tagClose = text.indexOf("</memory_json>");
    const ruleOpen = text.indexOf("<save_memory_rule>");
    expect(memoryOpen).toBeGreaterThan(-1);
    expect(tagOpen).toBeGreaterThan(memoryOpen);
    expect(tagClose).toBeGreaterThan(tagOpen);
    expect(ruleOpen).toBeGreaterThan(tagClose);
    expect(text.substring(tagOpen, tagClose)).toContain('"role"');
    expect(text.substring(tagOpen, tagClose)).toContain('"backend"');
  });

  it("omits <save_memory_rule> when memory is null", async () => {
    const msg = await createSystemPromptWithMemoryTemplate("base", null, null);
    expect(String(msg.content)).not.toContain("<save_memory_rule>");
  });

  it("save_memory_rule points at the tool description instead of re-stating rules", async () => {
    const payload = { memory: { role: "backend" } };
    const msg = await createSystemPromptWithMemoryTemplate("base", payload, null);
    const text = String(msg.content);
    expect(text).toMatch(/save_memory tool description/i);
    expect(text).not.toMatch(/DO NOT save ephemeral/i);
    expect(text).not.toMatch(/overwrite with care/i);
  });

  it("omits <save_memory_rule> when payload is empty", async () => {
    const msg = await createSystemPromptWithMemoryTemplate("base", { memory: {} }, null);
    expect(String(msg.content)).not.toContain("<save_memory_rule>");
  });
});

// ponytail: buildMessages fixture — [user, assistant, user, assistant, ...]
// sequence with optional tool interleaving. Saves ~5 lines per case below.
function buildMessages(turns: Array<"u" | "a" | "t">): BaseMessage[] {
  const out: BaseMessage[] = [];
  let toolIdx = 0;
  for (const t of turns) {
    if (t === "u")
      out.push(new HumanMessage(`q${out.filter((m) => m instanceof HumanMessage).length}`));
    else if (t === "a")
      out.push(new AIMessage(`a${out.filter((m) => m instanceof AIMessage).length}`));
    else {
      toolIdx++;
      out.push(new ToolMessage({ content: `r${toolIdx}`, tool_call_id: `t${toolIdx}` }));
    }
  }
  return out;
}

// ponytail: a fully-formed SummaryEntry pick.
function summary(
  endMessageIndex: number,
  sequence = 1,
): ThreadSummariesPayload["summaries"][number] {
  return {
    sequence,
    summary: { entries: [] },
    startMessageIndex: 0,
    endMessageIndex,
    triggerReason: "turn_based",
    tokenCountBefore: 0,
    tokenCountAfter: 0,
    createdAt: "2026-07-06T00:00:00.000Z",
  };
}

describe("prepareMessagesForInvoke", () => {
  it("returns the (system-stripped) messages when there are no summaries", async () => {
    const msgs = [new SystemMessage("base"), ...buildMessages(["u", "a", "u", "a"])];
    expect((await prepareMessagesForInvoke(msgs, [])).map((m) => m.content)).toEqual([
      "q0",
      "a0",
      "q1",
      "a1",
    ]);
  });

  it("strips SystemMessage instances regardless of summary state", async () => {
    const msgs = [
      new SystemMessage("base 1"),
      new HumanMessage("q0"),
      new SystemMessage("base 2 — stray"),
      new AIMessage("a0"),
    ];
    const out = await prepareMessagesForInvoke(msgs, []);
    expect(out).toHaveLength(2);
    expect(out.every((m) => !(m instanceof SystemMessage))).toBe(true);
  });

  it("filters out ToolMessage instances and intermediate AIMessages with tool_calls when includeToolMessages is false", async () => {
    const aiWithToolsOnly = new AIMessage({
      content: "",
      tool_calls: [{ name: "search", args: {}, id: "t1" }],
    });
    const finalAnswer = new AIMessage({
      content: "Here is the weather result",
    });
    const msgs = [
      new SystemMessage("system"),
      new HumanMessage("q0"),
      aiWithToolsOnly,
      new ToolMessage({ content: "tool result", tool_call_id: "t1" }),
      finalAnswer,
      new HumanMessage("q1"),
    ];
    const out = await prepareMessagesForInvoke(msgs, [], undefined, { includeToolMessages: false });
    expect(out.map((m) => m.content)).toEqual(["q0", "Here is the weather result", "q1"]);
    expect(out.every((m) => !(m instanceof ToolMessage))).toBe(true);
    for (const m of out) {
      if (m instanceof AIMessage) {
        expect(m.tool_calls).toEqual([]);
      }
    }
  });

  it("returns messages as-is when there are no human messages", async () => {
    const msgs = [new SystemMessage("base"), new AIMessage("orphan reply")];
    const out = await prepareMessagesForInvoke(msgs, [summary(0)]);
    expect(out.map((m) => m.content)).toEqual(["orphan reply"]);
  });

  it("retains recent buffer turns when maxEnd exceeds buffer count", async () => {
    // 12 human turns (0..11). maxEnd = 9 (covers 0..9). Buffer = 5.
    // effectiveTrimHumanIndex = 9 + 1 - 5 = 5.
    // Trim starts at human index 5 (q5).
    const msgs = buildMessages([
      "u",
      "a", // q0 (0)
      "u",
      "a", // q1 (1)
      "u",
      "a", // q2 (2)
      "u",
      "a", // q3 (3)
      "u",
      "a", // q4 (4)
      "u",
      "a", // q5 (5)
      "u",
      "a", // q6 (6)
      "u",
      "a", // q7 (7)
      "u",
      "a", // q8 (8)
      "u",
      "a", // q9 (9)
      "u",
      "a", // q10 (10)
      "u",
      "a", // q11 (11)
    ]);
    const out = await prepareMessagesForInvoke(msgs, [summary(9)]);
    expect(out.map((m) => m.content)).toEqual([
      "q5",
      "a5",
      "q6",
      "a6",
      "q7",
      "a7",
      "q8",
      "a8",
      "q9",
      "a9",
      "q10",
      "a10",
      "q11",
      "a11",
    ]);
  });

  it("returns all messages when maxEnd is smaller than buffer size", async () => {
    // 4 human turns, maxEnd = 1. effectiveTrimHumanIndex = 1 + 1 - 5 = -3 <= 0 -> returns noSystem.
    const msgs = buildMessages(["u", "a", "u", "a", "u", "a", "u", "a"]);
    const out = await prepareMessagesForInvoke(msgs, [summary(1)]);
    expect(out.map((m) => m.content)).toEqual(["q0", "a0", "q1", "a1", "q2", "a2", "q3", "a3"]);
  });

  it("does not mutate the input array", async () => {
    const msgs = [new SystemMessage("base"), ...buildMessages(["u", "a", "u", "a"])];
    const before = msgs.map((m) => m.content);
    await prepareMessagesForInvoke(msgs, [summary(1)]);
    expect(msgs.map((m) => m.content)).toEqual(before);
  });
});

// ponytail: the helper that all 4 agents call before invoking. Reads
// the current thread's compressed history from the store and shapes
// it into the LLM-facing payload. Failures degrade to null — better
// to lose continuity than to 500 a chat on store flake.
describe("loadThreadSummariesForPrompt", () => {
  // ponytail: vi.spyOn leaks between tests by default — restore after
  // each so a missed mock in one case doesn't poison the next.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseEntry = {
    threadId: "t1",
    sequence: 1,
    summary: { entries: [{ question: "q", answer: "a", refs: ["1"] }] },
    startMessageIndex: 0,
    endMessageIndex: 9,
    messageCount: 10,
    messageIds: ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"],
    triggerReason: "turn_based" as const,
    tokenCountBefore: 80,
    tokenCountAfter: 12,
    createdAt: "2026-07-06T00:00:00.000Z",
  };

  it("returns null when userId is missing from config", async () => {
    vi.spyOn(recall, "extractUserId").mockReturnValue(null);
    const out = await loadThreadSummariesForPrompt({} as never);
    expect(out).toBeNull();
  });

  it("returns null when threadId is missing from config", async () => {
    vi.spyOn(recall, "extractUserId").mockReturnValue("u1");
    vi.spyOn(recall, "extractThreadId").mockReturnValue(null);
    const out = await loadThreadSummariesForPrompt({} as never);
    expect(out).toBeNull();
  });

  it("returns null when the store has no summaries for this thread", async () => {
    vi.spyOn(recall, "extractUserId").mockReturnValue("u1");
    vi.spyOn(recall, "extractThreadId").mockReturnValue("t1");
    vi.spyOn(queries, "getThreadSummaries").mockResolvedValue([]);
    const out = await loadThreadSummariesForPrompt({} as never);
    expect(out).toBeNull();
  });

  it("shapes rows into ThreadSummariesPayload, sorted by sequence asc", async () => {
    vi.spyOn(recall, "extractUserId").mockReturnValue("u1");
    vi.spyOn(recall, "extractThreadId").mockReturnValue("t1");
    vi.spyOn(queries, "getThreadSummaries").mockResolvedValue([
      { ...baseEntry, sequence: 2 },
      { ...baseEntry, sequence: 1 },
      { ...baseEntry, sequence: 3 },
    ]);
    const out = await loadThreadSummariesForPrompt({} as never);
    expect(out?.threadId).toBe("t1");
    expect(out?.summaries.map((s) => s.sequence)).toEqual([1, 2, 3]);
  });

  it("strips fields the LLM doesn't consume (only LLM-relevant keys remain)", async () => {
    vi.spyOn(recall, "extractUserId").mockReturnValue("u1");
    vi.spyOn(recall, "extractThreadId").mockReturnValue("t1");
    vi.spyOn(queries, "getThreadSummaries").mockResolvedValue([baseEntry]);
    const out = await loadThreadSummariesForPrompt({} as never);
    const row = out?.summaries[0];
    expect(row).toBeDefined();
    // ponytail: threadId / messageCount / messageIds exist on the
    // store row but are not read by the LLM or prompt template —
    // intentionally dropped by the .map() in loadThreadSummariesForPrompt.
    expect(row).not.toHaveProperty("threadId");
    expect(row).not.toHaveProperty("messageCount");
    expect(row).not.toHaveProperty("messageIds");
  });

  it("swallows store errors and returns null (graceful degrade)", async () => {
    vi.spyOn(recall, "extractUserId").mockReturnValue("u1");
    vi.spyOn(recall, "extractThreadId").mockReturnValue("t1");
    vi.spyOn(queries, "getThreadSummaries").mockRejectedValue(new Error("DB down"));
    const out = await loadThreadSummariesForPrompt({} as never);
    expect(out).toBeNull();
  });
});
