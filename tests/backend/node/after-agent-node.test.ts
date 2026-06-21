import { describe, it, expect, beforeEach, vi } from "vitest";

const touchLastMessageAt = vi.fn();
vi.mock("@/lib/threads/queries", () => ({
  touchLastMessageAt: (...args: unknown[]) => touchLastMessageAt(...args),
}));

import { afterAgentNode } from "@/backend/node/after-agent-node";
import { db } from "@/db/client";
import { threads } from "@/lib/threads/schema";

const testUrl = process.env.DATABASE_URL_TEST;
if (!testUrl) throw new Error("DATABASE_URL required");

beforeEach(async () => {
  await db.delete(threads);
  touchLastMessageAt.mockReset();
});

describe("afterAgentNode", () => {
  it("calls touchLastMessageAt with the thread id from config", async () => {
    touchLastMessageAt.mockResolvedValueOnce(undefined);

    await afterAgentNode({}, { configurable: { thread_id: "thread-aa" } });

    expect(touchLastMessageAt).toHaveBeenCalledTimes(1);
    expect(touchLastMessageAt).toHaveBeenCalledWith("thread-aa");
  });

  it("is a no-op when no thread id is in config", async () => {
    await afterAgentNode({}, {});
    expect(touchLastMessageAt).not.toHaveBeenCalled();
  });

  it("returns no state update (pure side-effect node)", async () => {
    touchLastMessageAt.mockResolvedValueOnce(undefined);
    const result = await afterAgentNode({}, { configurable: { thread_id: "x" } });
    expect(result).toBeUndefined();
  });
});