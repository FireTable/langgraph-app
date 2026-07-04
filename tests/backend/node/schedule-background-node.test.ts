import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SDK client mock — used by the default (create) path.
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

// In-process background-agent mock — used by the invoke path.
const { mockBackgroundInvoke } = vi.hoisted(() => ({
  mockBackgroundInvoke: vi.fn(),
}));

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

vi.mock("@/backend/background-agent", () => ({
  graph: { invoke: mockBackgroundInvoke },
}));

import { scheduleBackgroundNode } from "@/backend/node/schedule-background-node";

const CONFIG_OK = {
  configurable: { userId: "u1", thread_id: "t1" },
};

beforeEach(() => {
  MockClientInstances.length = 0;
  mockRunsCreate.mockReset();
  mockBackgroundInvoke.mockReset();
  mockRunsCreate.mockResolvedValue({
    run_id: "r1",
    thread_id: "t1",
    status: "pending",
  });
  mockBackgroundInvoke.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("scheduleBackgroundNode — create path (default)", () => {
  beforeEach(() => {
    vi.stubEnv("INVOKE_BACKGROUND_AGENT", "");
  });

  it("returns an empty state update so the chat graph can continue immediately", async () => {
    const out = await scheduleBackgroundNode({ messages: [] }, CONFIG_OK);
    expect(out).toEqual({});
  });

  it("calls runs.create on the SDK with the right thread + assistant + payload", async () => {
    await scheduleBackgroundNode({ messages: [] }, CONFIG_OK);

    expect(MockClientInstances.length).toBe(1);
    expect(mockRunsCreate).toHaveBeenCalledTimes(1);
    const [threadId, assistantId, payload] = mockRunsCreate.mock.calls[0];
    expect(threadId).toBe("t1");
    expect(assistantId).toBe("background_agent");
    expect(payload).toMatchObject({
      input: { messages: [], userId: "u1", threadId: "t1" },
      multitaskStrategy: "enqueue",
      afterSeconds: 3,
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
      { type: "human", content: "hello" },
      { type: "ai", content: "hi" },
    ];
    await scheduleBackgroundNode({ messages }, CONFIG_OK);
    const [, , payload] = mockRunsCreate.mock.calls[0];
    expect(payload).toMatchObject({
      input: { messages, userId: "u1", threadId: "t1" },
    });
  });

  it("returns without dispatch when userId is missing", async () => {
    const out = await scheduleBackgroundNode(
      { messages: [] },
      { configurable: { thread_id: "t1" } },
    );
    expect(out).toEqual({});
    expect(mockRunsCreate).not.toHaveBeenCalled();
    expect(MockClientInstances.length).toBe(0);
  });

  it("returns without dispatch when thread_id is missing", async () => {
    const out = await scheduleBackgroundNode({ messages: [] }, { configurable: { userId: "u1" } });
    expect(out).toEqual({});
    expect(mockRunsCreate).not.toHaveBeenCalled();
  });

  it("catches create-path rejections and still returns an empty state update", async () => {
    mockRunsCreate.mockReset();
    mockRunsCreate.mockReturnValueOnce(Promise.reject(new Error("boom")));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await scheduleBackgroundNode({ messages: [] }, CONFIG_OK);
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

describe("scheduleBackgroundNode — invoke path (INVOKE_BACKGROUND_AGENT=true)", () => {
  beforeEach(() => {
    vi.stubEnv("INVOKE_BACKGROUND_AGENT", "true");
  });

  it("returns an empty state update so the chat graph can continue immediately", async () => {
    const out = await scheduleBackgroundNode({ messages: [] }, CONFIG_OK);
    expect(out).toEqual({});
  });

  it("calls backgroundAgentGraph.invoke with the same parameters as create-path's payload", async () => {
    const messages = [{ type: "human", content: "hi" }];
    await scheduleBackgroundNode({ messages }, CONFIG_OK);

    expect(mockBackgroundInvoke).toHaveBeenCalledTimes(1);
    expect(MockClientInstances.length).toBe(0);
    expect(mockRunsCreate).not.toHaveBeenCalled();

    const [input, opts] = mockBackgroundInvoke.mock.calls[0];
    expect(input).toMatchObject({
      messages,
      userId: "u1",
      threadId: "t1",
    });
    expect(opts).toMatchObject({
      configurable: expect.objectContaining({
        userId: "u1",
        thread_id: "t1",
      }),
    });
  });

  it("returns without dispatch when userId is missing", async () => {
    const out = await scheduleBackgroundNode(
      { messages: [] },
      { configurable: { thread_id: "t1" } },
    );
    expect(out).toEqual({});
    expect(mockBackgroundInvoke).not.toHaveBeenCalled();
  });

  it("returns without dispatch when thread_id is missing", async () => {
    const out = await scheduleBackgroundNode({ messages: [] }, { configurable: { userId: "u1" } });
    expect(out).toEqual({});
    expect(mockBackgroundInvoke).not.toHaveBeenCalled();
  });

  // ponytail: the invoke path's promise rejection is swallowed
  // INSIDE dispatchViaInvoke, not at the scheduleBackgroundNode
  // boundary — so node still returns {}. This is intentional
  // (matches the original cascade-abort diagnostic: invoke path
  // logs `[scheduleBackground] invoke path failed:` and the chat
  // invoke continues).
  it("swallows invoke rejection internally and returns empty state update", async () => {
    mockBackgroundInvoke.mockReset();
    mockBackgroundInvoke.mockReturnValueOnce(Promise.reject(new Error("Abort cascade")));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await scheduleBackgroundNode({ messages: [] }, CONFIG_OK);
      expect(out).toEqual({});
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("invoke path failed"),
        expect.any(Error),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// ponytail: cross-path sanity — both branches must reach background_agent
// with the SAME input shape so the chat-vs-background observability
// comparison is apples-to-apples. Locks in the contract regardless
// of which env flag is set.
describe("scheduleBackgroundNode — input contract parity (both paths)", () => {
  it("create and invoke paths emit identical userId / threadId / messages for the same input", async () => {
    const messages = [{ id: "m1", type: "human", content: "x" }];

    vi.stubEnv("INVOKE_BACKGROUND_AGENT", "");
    await scheduleBackgroundNode({ messages }, CONFIG_OK);
    const [, createAssistantId, createPayload] = mockRunsCreate.mock.calls[0];

    vi.stubEnv("INVOKE_BACKGROUND_AGENT", "true");
    await scheduleBackgroundNode({ messages }, CONFIG_OK);
    const [invokeInput, invokeOpts] = mockBackgroundInvoke.mock.calls[0];

    expect(createAssistantId).toBe("background_agent");

    expect(createPayload).toMatchObject({
      input: { messages, userId: "u1", threadId: "t1" },
      config: {
        configurable: { userId: "u1", thread_id: "t1" },
      },
    });
    expect(invokeInput).toMatchObject({
      messages,
      userId: "u1",
      threadId: "t1",
    });
    expect(invokeOpts).toMatchObject({
      configurable: { userId: "u1", thread_id: "t1" },
    });
  });
});
