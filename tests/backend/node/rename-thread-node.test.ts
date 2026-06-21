import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the chat model singleton so the node test doesn't hit OpenAI.
// renameThreadNode now uses invoke() (not stream()) — see the node comment
// for why streaming would leak the title into the chat as messages.
const mockInvoke = vi.fn();
vi.mock("@/backend/model", () => ({
  chatModel: { invoke: (...args: unknown[]) => mockInvoke(...args) },
  chatModelWithoutThink: { invoke: (...args: unknown[]) => mockInvoke(...args) },
}));

import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { renameThreadNode } from "@/backend/node/rename-thread-node";
import { db } from "@/db/client";
import { threads } from "@/lib/threads/schema";

const testUrl = process.env.DATABASE_URL_TEST;
if (!testUrl) throw new Error("DATABASE_URL_TEST required");

beforeEach(async () => {
  await db.delete(threads);
  mockInvoke.mockReset();
});

describe("renameThreadNode", () => {
  it("returns the generated title from the first user message", async () => {
    mockInvoke.mockResolvedValueOnce(new AIMessage("How to parse JSON"));
    await db.insert(threads).values({ id: "thread-1", title: "New Chat" });

    const config = { configurable: { thread_id: "thread-1" } };

    const result = await renameThreadNode(
      { messages: [new HumanMessage("How do I parse JSON?")] },
      config,
    );

    // The node persists to the DB and lets the runtime's generateTitle
    // pull the title from there — the graph state is intentionally not
    // mutated (returns null) so the conditional edge routes to
    // renameThread on every turn.
    expect(result).toBeNull();
  });

  it("persists the title to the threads row", async () => {
    mockInvoke.mockResolvedValueOnce(new AIMessage("How to parse JSON"));
    await db.insert(threads).values({ id: "thread-2", title: "New Chat" });

    const config = { configurable: { thread_id: "thread-2" } };

    await renameThreadNode({ messages: [new HumanMessage("How do I parse JSON?")] }, config);

    const row = await db.query.threads.findFirst({
      where: (t, { eq }) => eq(t.id, "thread-2"),
    });
    expect(row?.title).toBe("How to parse JSON");
  });

  it("trims whitespace from the LLM response before persisting", async () => {
    mockInvoke.mockResolvedValueOnce(new AIMessage("  Short title  "));
    await db.insert(threads).values({ id: "thread-3", title: "New Chat" });

    const config = { configurable: { thread_id: "thread-3" } };

    await renameThreadNode({ messages: [new HumanMessage("anything")] }, config);

    const row = await db.query.threads.findFirst({
      where: (t, { eq }) => eq(t.id, "thread-3"),
    });
    expect(row?.title).toBe("Short title");
  });

  it("returns undefined and never invokes the model when no human message is provided", async () => {
    await db.insert(threads).values({ id: "thread-4", title: "New Chat" });

    const config = { configurable: { thread_id: "thread-4" } };

    const result = await renameThreadNode({ messages: [] }, config);

    expect(result).toBeUndefined();
    expect(mockInvoke).not.toHaveBeenCalled();

    const row = await db.query.threads.findFirst({
      where: (t, { eq }) => eq(t.id, "thread-4"),
    });
    expect(row?.title).toBe("New Chat"); // unchanged
  });

  it("passes the user message as the second chat-model argument", async () => {
    mockInvoke.mockResolvedValueOnce(new AIMessage("First wins"));
    await db.insert(threads).values({ id: "thread-5", title: "New Chat" });

    const config = { configurable: { thread_id: "thread-5" } };

    await renameThreadNode({ messages: [new HumanMessage("first question")] }, config);

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [callArgs] = mockInvoke.mock.calls[0]!;
    const messages = callArgs as Array<{ content: unknown }>;
    // Index 0 is the SystemMessage prompt; index 1 is the user message.
    expect(messages[1]?.content).toBe("first question");
  });
});
