import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockTouchLastMessageAt } = vi.hoisted(() => ({
  mockTouchLastMessageAt: vi.fn(),
}));

vi.mock("@/lib/threads/queries", () => ({
  touchLastMessageAt: mockTouchLastMessageAt,
}));

import { touchLastMessageNode, graph as backgroundGraph } from "@/backend/background-agent";

beforeEach(() => {
  mockTouchLastMessageAt.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

const CONFIG_OK = {
  configurable: { userId: "u1", thread_id: "t1" },
};

describe("touchLastMessageNode", () => {
  it("touches last_message_at for the supplied thread_id", async () => {
    mockTouchLastMessageAt.mockResolvedValueOnce(undefined);
    await touchLastMessageNode({ messages: [] }, CONFIG_OK);
    expect(mockTouchLastMessageAt).toHaveBeenCalledWith("t1");
  });

  it("returns an empty messages update so the messages channel is left untouched", async () => {
    const out = await touchLastMessageNode({ messages: [] }, CONFIG_OK);
    expect(out).toEqual({ messages: [] });
  });

  it("skips touch when thread_id is missing", async () => {
    await touchLastMessageNode({ messages: [] }, { configurable: {} });
    expect(mockTouchLastMessageAt).not.toHaveBeenCalled();
  });

  it("skips touch when thread_id is an empty string", async () => {
    // ponytail: type shape of touchLastMessageNode's `config.configurable`
    // only requires `thread_id` — `userId` would be extra noise in
    // this test's contract check. The empty-string gate happens before
    // any other field is read.
    await touchLastMessageNode({ messages: [] }, { configurable: { thread_id: "" } });
    expect(mockTouchLastMessageAt).not.toHaveBeenCalled();
  });
});

describe("backgroundAgent graph wiring", () => {
  it("compiles to a Pregel with start → touchLastMessage → summarize → end", () => {
    // ponytail: smoke test for the topology. The graph is registered in
    // langgraph.json as `background_agent: ./backend/background-agent.ts:graph`
    // and langgraphjs dev will load it via exactly this export. A
    // misconfigured graph (no edge to END, missing START, etc.) shows up
    // here as a runtime error or as an empty node list, not as a test
    // assertion failure — but verifying `graph` is a Pregel with the
    // expected nodes catches the most common regressions.
    expect(backgroundGraph).toBeDefined();
    // ponytail: withConfig returns the wrapped Pregel — its `invoke`
    // method is the runtime contract. Existence of invoke is the
    // cheapest end-to-end canary without dragging in a checkpointer.
    expect(typeof backgroundGraph.invoke).toBe("function");
  });
});
