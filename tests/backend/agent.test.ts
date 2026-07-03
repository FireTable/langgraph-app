import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";

const { mockStream, mockInvoke, mockBindTools, mockInvokeStructured } = vi.hoisted(() => ({
  mockStream: vi.fn(),
  mockInvoke: vi.fn(),
  mockBindTools: vi.fn(),
  mockInvokeStructured: vi.fn(),
}));
vi.mock("@/backend/model", () => {
  const boundInvoke = (...args: unknown[]) => mockInvoke(...args);
  const boundBind = (...args: unknown[]) => {
    mockBindTools(...args);
    return { invoke: boundInvoke };
  };
  return {
    chatModel: {
      stream: (...args: unknown[]) => mockStream(...args),
      invoke: boundInvoke,
      bindTools: boundBind,
      // The router node binds this at module load; tests dispatch by
      // routing decision via mockInvokeStructured.
      withStructuredOutput: () => ({
        invoke: (...args: unknown[]) => mockInvokeStructured(...args),
      }),
    },
  };
});

import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";
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
  mockBindTools.mockReset();
  mockInvokeStructured.mockReset();
});

// Dispatch mocked chat-model invocations by the system prompt that
// leads the message list. routerAgent / chatAgent / weatherAgent /
// renameThreadAgent all invoke the same chatModel.
function mockByCallShape({
  routerDecision,
  agentReply,
  weatherReply,
  titleReply,
}: {
  routerDecision: { next: "weatherAgent" | "chatAgent" };
  agentReply: AIMessage;
  weatherReply: AIMessage;
  titleReply: AIMessage;
}) {
  mockInvokeStructured.mockResolvedValue(routerDecision);
  mockInvoke.mockImplementation((msgs: unknown) => {
    if (Array.isArray(msgs) && msgs[0] instanceof SystemMessage) {
      const content = (msgs[0] as SystemMessage).content as string;
      if (content.includes("title generator")) return Promise.resolve(titleReply);
      if (content.includes("weather questions")) return Promise.resolve(weatherReply);
    }
    return Promise.resolve(agentReply);
  });
}

describe("graph end-to-end", () => {
  it("non-weather turn: router dispatches to chatAgent, renameThreadAgent side-effects", async () => {
    const threadId = "e2e-first-" + Math.random().toString(36).slice(2, 8);
    // ponytail: seed title=DEFAULT_THREAD_TITLE ("New Chat") so the
    // conditional edge routes into renameThreadAgent — the LLM-generated
    // title is expected to overwrite the placeholder after the run.
    await db.insert(threads).values({ id: threadId, userId: owner, title: "New Chat" });
    const agentReply = new AIMessage("Sure, here's how to parse JSON.");
    const weatherReply = new AIMessage("(weather path never runs)");
    const titleReply = new AIMessage("How to parse JSON");
    mockByCallShape({
      routerDecision: { next: "chatAgent" },
      agentReply,
      weatherReply,
      titleReply,
    });

    const result = await graph.invoke(
      { messages: [new HumanMessage("How do I parse JSON?")] },
      { configurable: { thread_id: threadId } },
    );

    // routerDecision lives in state, not in messages.
    expect(result.routerDecision).toEqual({ next: "chatAgent" });
    expect(result.messages).toContain(agentReply);

    const row = await db.query.threads.findFirst({
      where: (t, { eq }) => eq(t.id, threadId),
    });
    expect(row?.title).toBe("How to parse JSON");
  });

  it("weather turn: router dispatches to weatherAgent, chatAgent's 'SHOULD NOT APPEAR' reply never reaches state", async () => {
    const threadId = "e2e-weather-" + Math.random().toString(36).slice(2, 8);
    // ponytail: same as above — title=DEFAULT_THREAD_TITLE so the
    // conditional edge routes into renameThreadAgent and the LLM
    // title persists over the placeholder.
    await db.insert(threads).values({ id: threadId, userId: owner, title: "New Chat" });
    const titleReply = new AIMessage("Beijing weather");
    // chatAgent's reply is poisoned: any time the chatAgent branch asks
    // for an LLM response, we'd return "SHOULD NOT APPEAR". The test
    // asserts that string never makes it into state.messages — which
    // is only possible if the weather turn never visited chatAgent.
    const poisonedReply = new AIMessage("SHOULD NOT APPEAR");
    const weatherReply = new AIMessage("Sunny in Beijing.");
    mockByCallShape({
      routerDecision: { next: "weatherAgent" },
      agentReply: poisonedReply,
      weatherReply,
      titleReply,
    });

    const result = await graph.invoke(
      { messages: [new HumanMessage("北京天气怎么样?")] },
      { configurable: { thread_id: threadId } },
    );

    expect(result.routerDecision).toEqual({ next: "weatherAgent" });
    const containsPoisoned = result.messages.some(
      (m) => m instanceof AIMessage && m.content === "SHOULD NOT APPEAR",
    );
    expect(containsPoisoned).toBe(false);

    const row = await db.query.threads.findFirst({
      where: (t, { eq }) => eq(t.id, threadId),
    });
    expect(row?.title).toBe("Beijing weather");
  });
});
