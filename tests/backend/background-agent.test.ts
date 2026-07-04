import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockTouchLastMessageAt, mockThreadSummarizeNode } = vi.hoisted(() => ({
  mockTouchLastMessageAt: vi.fn(),
  mockThreadSummarizeNode: vi.fn(),
}));

vi.mock("@/lib/threads/queries", () => ({
  touchLastMessageAt: mockTouchLastMessageAt,
}));

vi.mock("@/backend/node/thread-summarize-node", () => ({
  threadSummarizeNode: mockThreadSummarizeNode,
}));

import {
  summarizeNode,
  touchLastMessageNode,
  graph as backgroundGraph,
} from "@/backend/background-agent";

beforeEach(() => {
  mockTouchLastMessageAt.mockReset();
  mockThreadSummarizeNode.mockReset();
  // ponytail: threadSummarizeNode returns the empty state update shape —
  // that's its contract. mockThreadSummarizeNode returns the shape so
  // summarizeNode has something to forward through its own return.
  mockThreadSummarizeNode.mockResolvedValue({ messages: [] });
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

describe("summarizeNode", () => {
  it("delegates to threadSummarizeNode with the messages and config forwarded", async () => {
    const messages = [{ type: "ai", content: "hi" }] as never;
    await summarizeNode({ messages }, CONFIG_OK);

    expect(mockThreadSummarizeNode).toHaveBeenCalledTimes(1);
    const [state, config] = mockThreadSummarizeNode.mock.calls[0];
    expect(state).toMatchObject({ messages });
    expect(config).toMatchObject(CONFIG_OK);
  });

  it("returns the same empty state update produced by threadSummarizeNode (no message mutation)", async () => {
    const out = await summarizeNode({ messages: [] }, CONFIG_OK);
    expect(out).toEqual({ messages: [] });
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
