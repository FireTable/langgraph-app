import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";

const mockStream = vi.fn();
const mockInvoke = vi.fn();
vi.mock("@/backend/model", () => ({
  chatModel: {
    stream: (...args: unknown[]) => mockStream(...args),
    invoke: (...args: unknown[]) => mockInvoke(...args),
  },
  chatModelWithoutThink: { invoke: (...args: unknown[]) => mockInvoke(...args) },
}));

import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { graph } from "@/backend/agent";
import { db } from "@/db/client";
import { threads } from "@/lib/threads/schema";
import { ensureTestUser, TEST_USER } from "@/tests/helpers/auth";

const testUrl = process.env.DATABASE_URL_TEST;
if (!testUrl) throw new Error("DATABASE_URL_TEST required");

const owner = TEST_USER.id;

beforeAll(async () => {
  await ensureTestUser();
});

beforeEach(async () => {
  await db.delete(threads);
  mockStream.mockReset();
  mockInvoke.mockReset();
});

describe("graph end-to-end", () => {
  it("first run fans out agent + renameThread; DB row gets a generated title", async () => {
    const threadId = "e2e-first-" + Math.random().toString(36).slice(2, 8);
    await db.insert(threads).values({ id: threadId, userId: owner, title: "New Chat" });
    const aiReply = new AIMessage("Sure, here's how to parse JSON.");
    const titleReply = new AIMessage("How to parse JSON");
    mockInvoke.mockResolvedValueOnce(aiReply);
    mockInvoke.mockResolvedValueOnce(titleReply);

    const result = await graph.invoke(
      { messages: [new HumanMessage("How do I parse JSON?")] },
      { configurable: { thread_id: threadId } },
    );

    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toBe(aiReply);

    const row = await db.query.threads.findFirst({
      where: (t, { eq }) => eq(t.id, threadId),
    });
    expect(row?.title).toBe("How to parse JSON");
  });

  it("second run on the same thread re-runs renameThread; DB title gets refreshed", async () => {
    const threadId = "e2e-second-" + Math.random().toString(36).slice(2, 8);
    await db.insert(threads).values({ id: threadId, userId: owner, title: "New Chat" });
    mockInvoke.mockResolvedValueOnce(new AIMessage("First reply"));
    mockInvoke.mockResolvedValueOnce(new AIMessage("Initial title"));
    await graph.invoke(
      { messages: [new HumanMessage("first question")] },
      { configurable: { thread_id: threadId } },
    );

    mockInvoke.mockClear();
    mockInvoke.mockResolvedValueOnce(new AIMessage("Second reply"));
    mockInvoke.mockResolvedValueOnce(new AIMessage("Refreshed title"));

    await graph.invoke(
      { messages: [new HumanMessage("follow up question")] },
      { configurable: { thread_id: threadId } },
    );

    expect(mockInvoke).toHaveBeenCalledTimes(2);

    const row = await db.query.threads.findFirst({
      where: (t, { eq }) => eq(t.id, threadId),
    });
    expect(row?.title).toBe("Refreshed title");
  });
});
