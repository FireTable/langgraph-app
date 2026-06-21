import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the chat model singletons so the e2e graph test doesn't hit OpenAI.
// `chatModel` powers the agent node (invoke + stream); `chatModelWithoutThink`
// powers the rename-thread node (invoke only — see the node comment for why
// streaming would leak the title into the chat as messages).
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

const testUrl = process.env.DATABASE_URL_TEST;
if (!testUrl) throw new Error("DATABASE_URL_TEST required");

beforeEach(async () => {
  await db.delete(threads);
  mockStream.mockReset();
  mockInvoke.mockReset();
});

describe("graph end-to-end", () => {
  it("first run fans out agent + renameThread; DB row gets a generated title", async () => {
    const threadId = "e2e-first-" + Math.random().toString(36).slice(2, 8);
    await db.insert(threads).values({ id: threadId, title: "New Chat" });
    const aiReply = new AIMessage("Sure, here's how to parse JSON.");
    const titleReply = new AIMessage("How to parse JSON");
    mockInvoke.mockResolvedValueOnce(aiReply);
    mockInvoke.mockResolvedValueOnce(titleReply);

    const result = await graph.invoke(
      { messages: [new HumanMessage("How do I parse JSON?")] },
      { configurable: { thread_id: threadId } },
    );

    // Both nodes ran: assistant reply is appended, title is persisted to DB.
    // state.title is null because rename-thread-node no longer mutates graph
    // state — the runtime pulls the title from the DB via generateTitle.
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toBe(aiReply);
    expect(result.title).toBeNull();

    const row = await db.query.threads.findFirst({
      where: (t, { eq }) => eq(t.id, threadId),
    });
    expect(row?.title).toBe("How to parse JSON");
  });

  it("second run on the same thread re-runs renameThread (state.title stays null); DB title gets refreshed", async () => {
    const threadId = "e2e-second-" + Math.random().toString(36).slice(2, 8);
    await db.insert(threads).values({ id: threadId, title: "New Chat" });
    // First run: both invokes.
    mockInvoke.mockResolvedValueOnce(new AIMessage("First reply"));
    mockInvoke.mockResolvedValueOnce(new AIMessage("Initial title"));
    await graph.invoke(
      { messages: [new HumanMessage("first question")] },
      { configurable: { thread_id: threadId } },
    );

    // Second run: since state.title is never set, the conditional always
    // routes to renameThread — the LLM regenerates the title and the DB
    // gets updated. The runtime's generateTitle then pulls the fresh
    // value from the DB.
    mockInvoke.mockClear();
    mockInvoke.mockResolvedValueOnce(new AIMessage("Second reply"));
    mockInvoke.mockResolvedValueOnce(new AIMessage("Refreshed title"));

    const result = await graph.invoke(
      { messages: [new HumanMessage("follow up question")] },
      { configurable: { thread_id: threadId } },
    );

    // Both agent and renameThread ran.
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(result.title).toBeNull();

    const row = await db.query.threads.findFirst({
      where: (t, { eq }) => eq(t.id, threadId),
    });
    expect(row?.title).toBe("Refreshed title");
  });
});
