import { describe, it, expect, beforeEach, vi } from "vitest";

const mockTouchLastMessageAt = vi.fn();
vi.mock("@/lib/threads/queries", () => ({
  touchLastMessageAt: (...args: unknown[]) => mockTouchLastMessageAt(...args),
}));

import { afterAgentNode } from "@/backend/node/after-agent-node";

beforeEach(() => {
  mockTouchLastMessageAt.mockReset();
});

describe("afterAgentNode", () => {
  it("calls touchLastMessageAt with the thread id", async () => {
    mockTouchLastMessageAt.mockResolvedValueOnce(undefined);

    await afterAgentNode({}, { configurable: { thread_id: "thread-aa" } });

    expect(mockTouchLastMessageAt).toHaveBeenCalledTimes(1);
    expect(mockTouchLastMessageAt).toHaveBeenCalledWith("thread-aa");
  });

  it("is a no-op when no thread id is in config", async () => {
    await afterAgentNode({}, {});
    expect(mockTouchLastMessageAt).not.toHaveBeenCalled();
  });

  it("returns no state update (pure side-effect node)", async () => {
    mockTouchLastMessageAt.mockResolvedValueOnce(undefined);
    const result = await afterAgentNode({}, { configurable: { thread_id: "x" } });
    expect(result).toBeUndefined();
  });
});
