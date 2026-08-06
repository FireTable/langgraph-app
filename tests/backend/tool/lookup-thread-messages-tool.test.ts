import { describe, it, expect, vi, afterEach } from "vitest";
import { HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import { lookupThreadMessagesTool } from "@/backend/tool/memory/lookup-thread-messages-tool";
import * as recall from "@/backend/memory/recall";
import * as queries from "@/lib/memory/queries";
import * as checkpointerModule from "@/backend/checkpointer";

describe("lookupThreadMessagesTool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mockSummaries = [
    {
      threadId: "t1",
      sequence: 1,
      startMessageIndex: 0,
      endMessageIndex: 4,
      messageCount: 5,
      messageIds: ["m0", "m1", "m2", "m3", "m4"],
      summary: {
        entries: [
          {
            question: "How to optimize React components?",
            answer: "Use React.memo and useMemo hooks.",
            refs: ["#1", "#2"],
          },
          {
            question: "What is state batching?",
            answer: "State updates in React 18 are batched automatically.",
            refs: ["#3"],
          },
        ],
      },
      triggerReason: "turn_based" as const,
      tokenCountBefore: 100,
      tokenCountAfter: 20,
      createdAt: "2026-08-01T00:00:00.000Z",
    },
  ];

  it("returns error payload when userId or threadId is missing", async () => {
    vi.spyOn(recall, "extractUserId").mockReturnValue(null);
    vi.spyOn(recall, "extractThreadId").mockReturnValue(null);

    const res = await (lookupThreadMessagesTool.invoke as unknown as Function)({ refs: "#1" });
    const parsed = JSON.parse(res);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Missing userId or threadId");
  });

  it("rehydrates true raw messages from checkpointer when available", async () => {
    vi.spyOn(recall, "extractUserId").mockReturnValue("u1");
    vi.spyOn(recall, "extractThreadId").mockReturnValue("t1");

    const rawMsgs = [
      new HumanMessage("Turn 1 Question"),
      new AIMessage("Turn 1 Answer"),
      new HumanMessage("Turn 2 Question"),
      new AIMessage({
        content: "Turn 2 Answer",
        tool_calls: [{ name: "search", args: {}, id: "c1" }],
      }),
      new ToolMessage({ content: "Tool output 2", tool_call_id: "c1" }),
      new HumanMessage("Turn 3 Question"),
      new AIMessage("Turn 3 Answer"),
    ];

    if (checkpointerModule.checkpointer) {
      vi.spyOn(checkpointerModule.checkpointer, "getTuple").mockResolvedValue({
        checkpoint: {
          v: 1,
          id: "cp1",
          ts: "1",
          channel_values: { messages: rawMsgs },
          channel_versions: {},
          versions_seen: {},
          pending_sends: [],
        },
        metadata: {},
        config: {},
      } as never);
    }

    const res = await (lookupThreadMessagesTool.invoke as unknown as Function)({
      refs: "#2",
      includeToolMessages: true,
    });
    const parsed = JSON.parse(res);
    expect(parsed.ok).toBe(true);
    expect(parsed.matchCount).toBe(1);
    expect(parsed.turns[0].ref).toBe("#2");
    expect(parsed.turns[0].messages).toHaveLength(3); // Human, AI, Tool
    expect(parsed.turns[0].messages[0].content).toBe("Turn 2 Question");
    expect(parsed.turns[0].messages[2].content).toBe("Tool output 2");
  });

  it("omits ToolMessage and toolCalls property when includeToolMessages is false", async () => {
    vi.spyOn(recall, "extractUserId").mockReturnValue("u1");
    vi.spyOn(recall, "extractThreadId").mockReturnValue("t1");

    const rawMsgs = [
      new HumanMessage("Turn 1 Question"),
      new AIMessage({
        content: "",
        tool_calls: [{ name: "search", args: {}, id: "c1" }],
      }),
      new ToolMessage({ content: "Tool output 1", tool_call_id: "c1" }),
      new AIMessage("Turn 1 Final Answer"),
    ];

    if (checkpointerModule.checkpointer) {
      vi.spyOn(checkpointerModule.checkpointer, "getTuple").mockResolvedValue({
        checkpoint: {
          v: 1,
          id: "cp1",
          ts: "1",
          channel_values: { messages: rawMsgs },
          channel_versions: {},
          versions_seen: {},
          pending_sends: [],
        },
        metadata: {},
        config: {},
      } as never);
    }

    const res = await (lookupThreadMessagesTool.invoke as unknown as Function)({
      refs: "#1",
      includeToolMessages: false,
    });
    const parsed = JSON.parse(res);
    expect(parsed.ok).toBe(true);
    expect(parsed.turns[0].messages).toHaveLength(2); // Human & Final AIMessage
    expect(parsed.turns[0].messages[0].content).toBe("Turn 1 Question");
    expect(parsed.turns[0].messages[1].content).toBe("Turn 1 Final Answer");
    expect(parsed.turns[0].messages[1].toolCalls).toBeUndefined();
  });

  it("falls back to summary entries if checkpointer messages are unavailable", async () => {
    vi.spyOn(recall, "extractUserId").mockReturnValue("u1");
    vi.spyOn(recall, "extractThreadId").mockReturnValue("t1");
    if (checkpointerModule.checkpointer) {
      vi.spyOn(checkpointerModule.checkpointer, "getTuple").mockResolvedValue(null as never);
    }
    vi.spyOn(queries, "getThreadSummaries").mockResolvedValue(mockSummaries);

    const res = await (lookupThreadMessagesTool.invoke as unknown as Function)({ refs: "#3" });
    const parsed = JSON.parse(res);
    expect(parsed.ok).toBe(true);
    expect(parsed.matchCount).toBe(1);
    expect(parsed.turns[0].ref).toBe("#3");
    expect(parsed.turns[0].messages[0].content).toBe("What is state batching?");
    expect(parsed.turns[0].messages[1].content).toBe(
      "State updates in React 18 are batched automatically.",
    );
  });

  it("matches range ref tags like #4-#5 when AI requests a single turn #5", async () => {
    vi.spyOn(recall, "extractUserId").mockReturnValue("u1");
    vi.spyOn(recall, "extractThreadId").mockReturnValue("t1");
    if (checkpointerModule.checkpointer) {
      vi.spyOn(checkpointerModule.checkpointer, "getTuple").mockResolvedValue(null as never);
    }
    const rangeSummaries = [
      {
        threadId: "t1",
        sequence: 1,
        startMessageIndex: 3,
        endMessageIndex: 5,
        messageCount: 2,
        messageIds: ["m3", "m4"],
        summary: {
          entries: [
            {
              question: "Shunde food recommendations",
              answer: "Fish sashimi and congee hotpot in Leliu.",
              refs: ["#4-#5"],
            },
          ],
        },
        triggerReason: "turn_based" as const,
        tokenCountBefore: 100,
        tokenCountAfter: 20,
        createdAt: "2026-08-01T00:00:00.000Z",
      },
    ];
    vi.spyOn(queries, "getThreadSummaries").mockResolvedValue(rangeSummaries);

    const res = await (lookupThreadMessagesTool.invoke as unknown as Function)({ refs: "#5" });
    const parsed = JSON.parse(res);
    expect(parsed.ok).toBe(true);
    expect(parsed.matchCount).toBe(1);
    expect(parsed.turns[0].ref).toBe("#4-#5");
    expect(parsed.turns[0].messages[0].content).toBe("Shunde food recommendations");
  });
});
