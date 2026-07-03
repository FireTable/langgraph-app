import { describe, it, expect, vi } from "vitest";
import type { Serialized } from "@langchain/core/load/serializable";
import { CapturingHandler } from "@/backend/observability/callback-collector";
import type { CapturedSpan } from "@/backend/observability/callback-collector";

// ponytail: regression guard for the deleted fire-and-forget DB lookup
// in start(). Mock the queries module so a re-introduction of an async
// `findLatestParentMessageId` call from a sync Start hook would fail
// this assertion. The DB fallback now lives entirely in
// `bulkInsertSpans` (queries.ts::backfillParentMessageIds), which is
// covered by its own tests under tests/lib/observability/.
vi.mock("@/lib/observability/queries", () => ({
  findLatestParentMessageId: vi.fn(async () => null),
}));

// ponytail: stub isGraphInterrupt so handleToolError can dispatch to
// the interrupt branch deterministically. vi.hoisted is required
// because vi.mock factories are hoisted above top-level let bindings.
const { isGraphInterruptMock } = vi.hoisted(() => ({
  isGraphInterruptMock: vi.fn((err: unknown): boolean => {
    const e = err as { name?: string } | null | undefined;
    return !!e && (e.name === "GraphInterrupt" || e.name === "NodeInterrupt");
  }),
}));
vi.mock("@langchain/langgraph", () => ({
  isGraphInterrupt: isGraphInterruptMock,
}));

// ponytail: Serialized is a structural union; tests only need an object
// with an `id` array so the handler can pull the class-name tail. Cast
// through unknown to bypass the union discriminator.
function fakeSerialized(name: string): Serialized {
  return { id: [name] } as unknown as Serialized;
}

function makeHandler(bulkInsert: (spans: CapturedSpan[]) => Promise<void>) {
  return new CapturingHandler({ bulkInsert });
}

describe("CapturingHandler — bulkInsert wiring", () => {
  it("calls bulkInsert with the span when its handleChainEnd fires", async () => {
    const bulkInsert = vi.fn(async () => {});
    const handler = makeHandler(bulkInsert);
    handler.handleChainStart(
      fakeSerialized("RunnableSequence"),
      {},
      "run-1",
      undefined,
      undefined,
      {
        langgraph_thread_id: "t-1",
      },
    );
    handler.handleChainEnd({ result: "ok" }, "run-1");
    expect(bulkInsert).toHaveBeenCalledTimes(1);
    const flushed = (bulkInsert.mock.calls[0] as unknown as [CapturedSpan[]])[0];
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.span_id).toBe("run-1");
    expect(flushed[0]?.status).toBe("completed");
  });

  it("swallows bulkInsert errors and does not throw out of handleChainEnd", async () => {
    const bulkInsert = vi.fn(async () => {
      throw new Error("db down");
    });
    const handler = makeHandler(bulkInsert);
    handler.handleChainStart(
      fakeSerialized("RunnableSequence"),
      {},
      "run-1",
      undefined,
      undefined,
      {
        langgraph_thread_id: "t-1",
      },
    );
    expect(() => handler.handleChainEnd({ ok: true }, "run-1")).not.toThrow();
  });

  it("fires bulkInsert once per chain end (not once per buffer entry)", async () => {
    const bulkInsert = vi.fn(async () => {});
    const handler = makeHandler(bulkInsert);
    handler.handleChainStart(fakeSerialized("outer"), {}, "outer", undefined, undefined, {
      langgraph_thread_id: "t-1",
    });
    handler.handleChainStart(fakeSerialized("inner"), {}, "inner", "outer", undefined, {
      langgraph_thread_id: "t-1",
    });
    handler.handleChainEnd({ ok: true }, "inner");
    handler.handleChainEnd({ ok: true }, "outer");
    expect(bulkInsert).toHaveBeenCalledTimes(2);
  });

  it("does not call bulkInsert when handleChainEnd is invoked without a matching Start", () => {
    const bulkInsert = vi.fn(async () => {});
    const handler = makeHandler(bulkInsert);
    handler.handleChainEnd({ ok: true }, "unknown-run");
    expect(bulkInsert).not.toHaveBeenCalled();
  });

  it("still works without a bulkInsert configured (default no-op)", () => {
    const handler = new CapturingHandler();
    handler.handleChainStart(
      fakeSerialized("RunnableSequence"),
      {},
      "run-1",
      undefined,
      undefined,
      {
        langgraph_thread_id: "t-1",
      },
    );
    expect(() => handler.handleChainEnd({ ok: true }, "run-1")).not.toThrow();
  });
});

describe("CapturingHandler — parent_message_id extraction", () => {
  it("tags every span with the last HumanMessage id from the outermost chain's inputs", async () => {
    const bulkInsert = vi.fn(async () => {});
    const handler = makeHandler(bulkInsert);
    handler.handleChainStart(
      fakeSerialized("CompiledStateGraph"),
      {
        messages: [
          { id: "h-1", type: "human", content: "first" },
          { id: "a-1", type: "ai", content: "first-reply" },
          { id: "h-2", type: "human", content: "second" },
        ],
      },
      "outer",
      undefined,
      undefined,
      { langgraph_thread_id: "t-1" },
    );
    handler.handleLLMStart(
      fakeSerialized("ChatOpenAI"),
      ["prompt"],
      "llm-1",
      "outer",
      undefined,
      undefined,
      { langgraph_thread_id: "t-1", langgraph_node: "agent" },
    );
    handler.handleLLMEnd({ generations: [[]] } as never, "llm-1");
    handler.handleChainEnd({ ok: true }, "outer");

    // ponytail: bulkInsert fires once per End hook. LLMEnd for llm-1
    // comes first → mock.calls[0] is [llm-1 span]. ChainEnd for outer
    // comes second → mock.calls[1] is [outer span]. Both should carry
    // the same parent_message_id since they're in the same invoke.
    const llmCall = (bulkInsert.mock.calls[0] as unknown as [CapturedSpan[]])[0];
    const chainCall = (bulkInsert.mock.calls[1] as unknown as [CapturedSpan[]])[0];
    expect(llmCall[0]?.span_id).toBe("llm-1");
    expect(llmCall[0]?.meta.parent_message_id).toBe("h-2");
    expect(chainCall[0]?.span_id).toBe("outer");
    expect(chainCall[0]?.meta.parent_message_id).toBe("h-2");
  });

  it("peels V1 envelope to find the human message id", async () => {
    const bulkInsert = vi.fn(async () => {});
    const handler = makeHandler(bulkInsert);
    // V1 envelope: {lc:1, type:"constructor", id:[...], kwargs:{type, id, content}}
    handler.handleChainStart(
      fakeSerialized("CompiledStateGraph"),
      {
        messages: [
          {
            lc: 1,
            type: "constructor",
            id: ["langchain_core", "messages", "HumanMessage"],
            kwargs: { type: "human", id: "h-envelope", content: "hi" },
          },
        ],
      },
      "outer-2",
      undefined,
      undefined,
      { langgraph_thread_id: "t-2" },
    );
    handler.handleChainEnd({ ok: true }, "outer-2");

    const flushed = (bulkInsert.mock.calls[0] as unknown as [CapturedSpan[]])[0];
    expect(flushed[0]?.meta.parent_message_id).toBe("h-envelope");
  });

  it("sets parent_message_id to null when the outermost chain has no human messages", async () => {
    const bulkInsert = vi.fn(async () => {});
    const handler = makeHandler(bulkInsert);
    handler.handleChainStart(
      fakeSerialized("CompiledStateGraph"),
      { messages: [] },
      "outer-3",
      undefined,
      undefined,
      { langgraph_thread_id: "t-3" },
    );
    handler.handleChainEnd({ ok: true }, "outer-3");
    const flushed = (bulkInsert.mock.calls[0] as unknown as [CapturedSpan[]])[0];
    expect(flushed[0]?.meta.parent_message_id).toBeNull();
  });

  it("clears parent_message_id after the outermost chain ends so the next invoke recomputes", async () => {
    const bulkInsert = vi.fn(async () => {});
    const handler = makeHandler(bulkInsert);
    // First invoke: human message h-A
    handler.handleChainStart(
      fakeSerialized("CompiledStateGraph"),
      { messages: [{ id: "h-A", type: "human", content: "a" }] },
      "run-A",
      undefined,
      undefined,
      { langgraph_thread_id: "t-4" },
    );
    handler.handleChainEnd({ ok: true }, "run-A");
    // Second invoke: human message h-B
    handler.handleChainStart(
      fakeSerialized("CompiledStateGraph"),
      { messages: [{ id: "h-B", type: "human", content: "b" }] },
      "run-B",
      undefined,
      undefined,
      { langgraph_thread_id: "t-4" },
    );
    handler.handleChainEnd({ ok: true }, "run-B");

    // First call: outer-A end → span meta has h-A
    const callA = (bulkInsert.mock.calls[0] as unknown as [CapturedSpan[]])[0];
    expect(callA[0]?.meta.parent_message_id).toBe("h-A");
    // Second call: outer-B end → span meta has h-B (not stuck on h-A)
    const callB = (bulkInsert.mock.calls[1] as unknown as [CapturedSpan[]])[0];
    expect(callB[0]?.meta.parent_message_id).toBe("h-B");
  });
});

describe("CapturingHandler — sync Start hooks stay sync", () => {
  // ponytail: the DB fallback for missing parent_message_id lives in
  // bulkInsertSpans (pre-INSERT backfill). The Start hook is sync and
  // MUST NOT touch the queries module — the previous fire-and-forget
  // `.then()` block was a race (promise resolved after bulkInsertSpans
  // had already snapshotted the spans). Mocking queries + asserting
  // it's never called locks the invariant.
  it("does not call findLatestParentMessageId from handleChainStart when inputs has no HumanMessage", async () => {
    const { findLatestParentMessageId } = await import("@/lib/observability/queries");
    const bulkInsert = vi.fn(async () => {});
    const handler = makeHandler(bulkInsert);
    handler.handleChainStart(
      fakeSerialized("CompiledStateGraph"),
      { messages: [] },
      "outer-cold",
      undefined,
      undefined,
      { langgraph_thread_id: "t-cold" },
    );
    handler.handleChainEnd({ ok: true }, "outer-cold");
    expect(findLatestParentMessageId).not.toHaveBeenCalled();
  });

  it("does not schedule async work from handleLLMStart even when parent pmid is null", async () => {
    const { findLatestParentMessageId } = await import("@/lib/observability/queries");
    const bulkInsert = vi.fn(async () => {});
    const handler = makeHandler(bulkInsert);
    handler.handleChainStart(
      fakeSerialized("CompiledStateGraph"),
      { messages: [] },
      "outer-llm",
      undefined,
      undefined,
      { langgraph_thread_id: "t-llm" },
    );
    handler.handleLLMStart(
      fakeSerialized("ChatOpenAI"),
      ["prompt"],
      "llm-1",
      "outer-llm",
      undefined,
      undefined,
      { langgraph_thread_id: "t-llm" },
    );
    handler.handleLLMEnd({ generations: [[]] } as never, "llm-1");
    handler.handleChainEnd({ ok: true }, "outer-llm");
    expect(findLatestParentMessageId).not.toHaveBeenCalled();
  });
});

// ponytail: handleToolError + interrupt semantics. When `interrupt()`
// fires inside a tool, the tool call is intentional, not a failure.
// We flip the tool span to `waiting`, insert a sibling `kind: "human"`
// span to mark the wait gap, and finalize the human span on the next
// outermost handleChainStart (the resume).
describe("CapturingHandler — interrupt / human span", () => {
  function interruptError(): Error {
    const e = new Error("GraphInterrupt") as Error & { name: string };
    e.name = "GraphInterrupt";
    return e;
  }

  it("flips the tool span to status=completed + clears error + ended_at when interrupt() fires", () => {
    const bulkInsert = vi.fn(async () => {});
    const handler = makeHandler(bulkInsert);
    handler.handleChainStart(
      fakeSerialized("CompiledStateGraph"),
      {},
      "outer",
      undefined,
      undefined,
      { langgraph_thread_id: "t-int" },
    );
    // handleToolStart signature: (tool, input, runId, parentRunId?, tags?, metadata?, runName?, toolCallId?)
    handler.handleToolStart(fakeSerialized("ask_location"), "{}", "tool-1", "outer", undefined, {
      langgraph_thread_id: "t-int",
    });
    handler.handleToolError(interruptError(), "tool-1");

    // bulkInsert calls: [0] = tool span re-persisted as completed, [1] = human span
    const toolFlushed = (bulkInsert.mock.calls[0] as unknown as [CapturedSpan[]])[0];
    expect(toolFlushed[0]?.span_id).toBe("tool-1");
    expect(toolFlushed[0]?.status).toBe("completed");
    expect(toolFlushed[0]?.error).toBeNull();
    // ponytail: ended_at is stamped to Date.now() (not left null) so
    // markRunningAsFailed — which keys on ended_at === null to flag
    // aborted invokes — doesn't mis-attribute the interrupted tool as
    // a crashed run. The synthetic human span alongside carries the
    // "wait" semantics; the tool's ended_at just needs to be non-null.
    expect(toolFlushed[0]?.ended_at).not.toBeNull();
  });

  it("inserts a child human span with kind=human, status=waiting, parented to the tool", () => {
    const bulkInsert = vi.fn(async () => {});
    const handler = makeHandler(bulkInsert);
    handler.handleChainStart(
      fakeSerialized("CompiledStateGraph"),
      {},
      "outer",
      undefined,
      undefined,
      { langgraph_thread_id: "t-int-2" },
    );
    handler.handleToolStart(fakeSerialized("ask_location"), "{}", "tool-2", "outer", undefined, {
      langgraph_thread_id: "t-int-2",
    });
    handler.handleToolError(interruptError(), "tool-2");

    const toolFlushed = (bulkInsert.mock.calls[0] as unknown as [CapturedSpan[]])[0];
    const humanFlushed = (bulkInsert.mock.calls[1] as unknown as [CapturedSpan[]])[0];
    const human = humanFlushed[0];
    expect(human?.span_id).toBe("tool-2-interrupt");
    expect(human?.name).toBe("interrupt");
    expect(human?.kind).toBe("human");
    expect(human?.status).toBe("waiting");
    expect(human?.ended_at).toBeNull();
    // human is parented to the tool (not the tool's parent), so the
    // panel nests it directly under the tool bar.
    expect(human?.parent_span_id).toBe(toolFlushed[0]?.span_id);
    expect((human?.meta as Record<string, unknown>)?.langgraph_thread_id).toBe("t-int-2");
    expect((human?.meta as Record<string, unknown>)?.interrupt).toBe(true);
  });

  it("treats a regular tool error as failed (does not insert a human span)", () => {
    const bulkInsert = vi.fn(async () => {});
    const handler = makeHandler(bulkInsert);
    handler.handleChainStart(
      fakeSerialized("CompiledStateGraph"),
      {},
      "outer",
      undefined,
      undefined,
      { langgraph_thread_id: "t-reg" },
    );
    handler.handleToolStart(fakeSerialized("ask_location"), "{}", "tool-x", "outer", undefined, {
      langgraph_thread_id: "t-reg",
    });
    handler.handleToolError(new Error("boom"), "tool-x");

    expect(bulkInsert).toHaveBeenCalledTimes(1);
    const flushed = (bulkInsert.mock.calls[0] as unknown as [CapturedSpan[]])[0];
    expect(flushed[0]?.status).toBe("failed");
    expect(flushed[0]?.error).toBe("boom");
  });

  // ponytail: the resume-finalize logic was dropped together with the
  // `openHumanSpanId` field — in-memory state dies on `langgraphjs dev`
  // process restart, so the field is write-only in practice. The human
  // span stays `status: "waiting"` (panel maps to `running`) until
  // something else updates it; that's the deliberate MVP trade-off.
});

describe("CapturingHandler — payload trims (Phase 1)", () => {
  it("strips redundant fields from incoming meta before persisting", async () => {
    const bulkInsert = vi.fn(async () => {});
    const handler = makeHandler(bulkInsert);
    handler.handleChainStart(
      fakeSerialized("RunnableSequence"),
      {},
      "run-meta",
      undefined,
      undefined,
      {
        langgraph_thread_id: "t-1",
        // Phase-1b keepers:
        langgraph_node: "chatModel",
        langgraph_step: 2,
        langgraph_checkpoint_ns: "chatModel:abc",
        ls_model_name: "gpt-5-mini",
        time_to_first_token_ms: 120,
        // Phase-1b droppers:
        ls_provider: "openai",
        ls_model_type: "chat",
        graph_id: "agent",
        assistant_id: "fe096781-...",
        versions: { "@langchain/core": "1.2.1" },
        langgraph_host: "self-hosted",
        langgraph_api_url: "http://localhost:2024",
        langgraph_version: "1.4.7",
        ls_integration: "langchain_chat_model",
        run_attempt: 1,
        langgraph_path: ["__pregel_pull", "chatModel"],
        langgraph_triggers: ["branch:to:chatModel"],
        checkpoint_ns: "chatModel:abc",
      },
    );
    handler.handleChainEnd({ ok: true }, "run-meta");
    const [spans] = bulkInsert.mock.calls[0] as unknown as [CapturedSpan[]];
    const kept = spans[0].meta as Record<string, unknown>;
    expect(kept.langgraph_node).toBe("chatModel");
    expect(kept.langgraph_step).toBe(2);
    expect(kept.langgraph_checkpoint_ns).toBe("chatModel:abc");
    expect(kept.ls_model_name).toBe("gpt-5-mini");
    expect(kept.time_to_first_token_ms).toBe(120);
    expect(kept).not.toHaveProperty("ls_provider");
    expect(kept).not.toHaveProperty("ls_model_type");
    expect(kept).not.toHaveProperty("graph_id");
    expect(kept).not.toHaveProperty("assistant_id");
    expect(kept).not.toHaveProperty("versions");
    expect(kept).not.toHaveProperty("langgraph_host");
    expect(kept).not.toHaveProperty("langgraph_api_url");
    expect(kept).not.toHaveProperty("langgraph_version");
    expect(kept).not.toHaveProperty("ls_integration");
    expect(kept).not.toHaveProperty("run_attempt");
    expect(kept).not.toHaveProperty("langgraph_path");
    expect(kept).not.toHaveProperty("langgraph_triggers");
    expect(kept).not.toHaveProperty("checkpoint_ns");
  });

  it("strips duplicate prompt/completion counters from LLM output response_metadata", async () => {
    const bulkInsert = vi.fn(async () => {});
    const handler = makeHandler(bulkInsert);
    handler.handleChatModelStart(
      fakeSerialized("ChatOpenAI"),
      [[{ getType: () => "human", content: "" } as never]],
      "run-out",
      undefined,
      undefined,
      undefined,
      { thread_id: "t-1", langgraph_node: "chatModel" },
    );
    handler.handleLLMEnd(
      {
        generations: [
          [
            {
              text: "Hi",
              message: { usage_metadata: { input_tokens: 1, output_tokens: 2 } },
              generationInfo: { prompt: 0, completion: 0, system_fingerprint: "x" },
            } as never,
          ],
        ],
        llmOutput: {
          estimatedTokenUsage: { promptTokens: 1, completionTokens: 2 },
        },
      } as never,
      "run-out",
    );
    const [spans] = bulkInsert.mock.calls[0] as unknown as [CapturedSpan[]];
    const out = spans[0].output as {
      generations: Array<Array<Record<string, unknown>>>;
      llmOutput?: unknown;
    };
    const genInfo = (out.generations[0]?.[0]?.generationInfo ?? {}) as Record<string, unknown>;
    // prompt/completion counters and system_fingerprint dropped:
    expect(genInfo).not.toHaveProperty("prompt");
    expect(genInfo).not.toHaveProperty("completion");
    expect(genInfo).not.toHaveProperty("system_fingerprint");
  });
});

describe("CapturingHandler — AIMessage with tool_calls renders body", () => {
  // ponytail: handleChatModelStart records the LLM span on a Start hook
  // and the matching handleLLMEnd flushes it through bulkInsert. Going
  // through both hooks is the only way to inspect the captured input.
  function capturePrompt(messages: Array<Record<string, unknown>>, runId: string) {
    const bulkInsert = vi.fn(async () => {});
    const handler = makeHandler(bulkInsert);
    handler.handleChatModelStart(fakeSerialized("ChatOpenAI"), [messages] as never, runId);
    handler.handleLLMEnd({ generations: [] } as never, runId);
    const [spans] = bulkInsert.mock.calls[0] as unknown as [CapturedSpan[]];
    return (spans[0].input as { prompts: string[] }).prompts[0];
  }

  it("serializes tool_call name + args when content is empty", () => {
    const prompt = capturePrompt(
      [
        {
          getType: () => "ai",
          content: "",
          tool_calls: [{ name: "geocode_location", args: { location: "LongJiang" } }],
        },
      ],
      "run-tc",
    );
    expect(prompt).toBe('ai: [tool_call geocode_location({"location":"LongJiang"})]');
  });

  it("prefers content over tool_calls when both are present", () => {
    const prompt = capturePrompt(
      [
        {
          getType: () => "ai",
          content: "let me look that up",
          tool_calls: [{ name: "get_weather", args: { lat: 22.8, lon: 113.1 } }],
        },
      ],
      "run-both",
    );
    expect(prompt).toBe("ai: let me look that up");
  });

  it("renders content as-is for plain AI text replies (no tool_calls)", () => {
    const prompt = capturePrompt([{ getType: () => "ai", content: "hello there" }], "run-text");
    expect(prompt).toBe("ai: hello there");
  });
});
