import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";

// SDK client mock — single dispatch path is via runs.create.
type RunPayload = unknown;
type RunsCreateFn = (
  threadId: string | null,
  assistantId: string,
  payload?: RunPayload,
) => Promise<unknown>;
type FakeClient = { runs: { create: RunsCreateFn } };

const { mockRunsCreate, MockClientInstances } = vi.hoisted(
  (): {
    mockRunsCreate: ReturnType<typeof vi.fn>;
    MockClientInstances: FakeClient[];
  } => ({
    mockRunsCreate: vi.fn() as ReturnType<typeof vi.fn>,
    MockClientInstances: [] as FakeClient[],
  }),
);

vi.mock("@langchain/langgraph-sdk", () => {
  return {
    Client: class FakeClient {
      runs = { create: mockRunsCreate as RunsCreateFn };
      constructor(_opts: unknown) {
        MockClientInstances.push(this as unknown as FakeClient);
      }
    },
  };
});

import { triggerBackgroundAgentNode } from "@/backend/node/trigger-background-agent-node";

const CONFIG_OK = {
  configurable: { userId: "u1", thread_id: "t1" },
};

beforeEach(() => {
  MockClientInstances.length = 0;
  mockRunsCreate.mockReset();
  mockRunsCreate.mockResolvedValue({
    run_id: "r1",
    thread_id: "t1",
    status: "pending",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("triggerBackgroundAgentNode", () => {
  it("returns an empty state update so the chat graph can continue immediately", async () => {
    const out = await triggerBackgroundAgentNode({ messages: [] }, CONFIG_OK);
    expect(out).toEqual({});
  });

  it("calls runs.create on the SDK with the right thread + assistant + payload", async () => {
    await triggerBackgroundAgentNode({ messages: [] }, CONFIG_OK);

    expect(mockRunsCreate).toHaveBeenCalledTimes(1);
    const [threadId, assistantId, payload] = mockRunsCreate.mock.calls[0];
    expect(threadId).toBe("t1");
    expect(assistantId).toBe("background_agent");
    expect(payload).toMatchObject({
      input: { messages: [], userId: "u1", threadId: "t1" },
      multitaskStrategy: "enqueue",
      config: {
        configurable: expect.objectContaining({
          userId: "u1",
          thread_id: "t1",
        }),
      },
    });
  });

  it("forwards messages from the chat graph to the background input payload", async () => {
    const messages = [
      new HumanMessage({ content: "hello", id: "h-1" }),
      new AIMessage({ content: "hi", id: "a-1" }),
    ];
    await triggerBackgroundAgentNode({ messages }, CONFIG_OK);
    const [, , payload] = mockRunsCreate.mock.calls[0];
    expect(payload).toMatchObject({
      input: { messages, userId: "u1", threadId: "t1" },
    });
  });

  it("stamps parent_message_id from the last HumanMessage so the per-turn panel can scope the in-flight run", async () => {
    // ponytail: the bg invoke runs on the same thread as the chat invoke,
    // so without parent_message_id the observability API's runs.list
    // filter can't tell bg-of-turn-N apart from bg-of-turn-N+1.
    const messages = [
      new HumanMessage({ content: "first turn", id: "h-1" }),
      new AIMessage({ content: "ack", id: "a-1" }),
      new HumanMessage({ content: "second turn", id: "h-2" }),
    ];
    await triggerBackgroundAgentNode({ messages }, CONFIG_OK);
    const [, , payload] = mockRunsCreate.mock.calls[0];
    expect(payload).toMatchObject({
      metadata: { parent_message_id: "h-2" },
    });
  });

  it("passes null parent_message_id when no HumanMessage has an id", async () => {
    // ponytail: API filter `r.metadata?.parent_message_id === params.parentMessageId`
    // treats null on both sides as a match, so a turn without ids still
    // surfaces — we just can't disambiguate it from other id-less turns.
    const messages = [new HumanMessage({ content: "no id here" })];
    await triggerBackgroundAgentNode({ messages }, CONFIG_OK);
    const [, , payload] = mockRunsCreate.mock.calls[0];
    expect(payload).toMatchObject({
      metadata: { parent_message_id: null },
    });
  });

  it("returns without dispatch when userId is missing", async () => {
    const out = await triggerBackgroundAgentNode(
      { messages: [] },
      { configurable: { thread_id: "t1" } },
    );
    expect(out).toEqual({});
    expect(mockRunsCreate).not.toHaveBeenCalled();
    expect(MockClientInstances.length).toBe(0);
  });

  it("returns without dispatch when thread_id is missing", async () => {
    const out = await triggerBackgroundAgentNode(
      { messages: [] },
      { configurable: { userId: "u1" } },
    );
    expect(out).toEqual({});
    expect(mockRunsCreate).not.toHaveBeenCalled();
  });

  it("catches create-path rejections and still returns an empty state update", async () => {
    mockRunsCreate.mockReset();
    mockRunsCreate.mockReturnValueOnce(Promise.reject(new Error("boom")));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await triggerBackgroundAgentNode({ messages: [] }, CONFIG_OK);
      expect(out).toEqual({});
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("create path failed"),
        expect.any(Error),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
