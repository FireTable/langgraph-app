import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Serialized } from "@langchain/core/load/serializable";
import { HumanMessage } from "@langchain/core/messages";
import { CapturingHandler } from "@/lib/observability/callback";
import type { CapturedSpan } from "@/lib/observability/callback";

// ponytail: CapturingHandler calls `bulkInsertSpans` directly (no
// constructor injection). Mock the queries module so we can verify
// the wiring without touching the real DB.
const { bulkInsertSpansMock, findLatestParentMessageIdMock } = vi.hoisted(() => ({
  bulkInsertSpansMock: vi.fn(async () => {}),
  findLatestParentMessageIdMock: vi.fn(async () => null),
}));
vi.mock("@/lib/observability/queries", () => ({
  bulkInsertSpans: bulkInsertSpansMock,
  findLatestParentMessageId: findLatestParentMessageIdMock,
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

// ponytail: reset the hoisted mocks between tests so call counts are
// per-test. Without this, expect.toHaveBeenCalledTimes(N) accumulates
// across the file's tests and fails the second test that fires >1 calls.
beforeEach(() => {
  bulkInsertSpansMock.mockReset();
  bulkInsertSpansMock.mockResolvedValue(undefined);
  findLatestParentMessageIdMock.mockReset();
  findLatestParentMessageIdMock.mockResolvedValue(null);
  isGraphInterruptMock.mockReset();
  isGraphInterruptMock.mockImplementation((err: unknown): boolean => {
    const e = err as { name?: string } | null | undefined;
    return !!e && (e.name === "GraphInterrupt" || e.name === "NodeInterrupt");
  });
});

// ponytail: Serialized is a structural union; tests only need an object
// with an `id` array so the handler can pull the class-name tail. Cast
// through unknown to bypass the union discriminator.
function fakeSerialized(name: string): Serialized {
  return { id: [name] } as unknown as Serialized;
}

function makeHandler() {
  return new CapturingHandler();
}

describe("CapturingHandler — bulkInsert wiring", () => {
  it("calls bulkInsert with the span when its handleChainEnd fires", async () => {
    const handler = makeHandler();
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
    expect(bulkInsertSpansMock).toHaveBeenCalledTimes(1);
    const flushed = (bulkInsertSpansMock.mock.calls[0] as unknown as [CapturedSpan[]])[0];
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.span_id).toBe("run-1");
    expect(flushed[0]?.status).toBe("completed");
  });

  it("swallows bulkInsert errors and does not throw out of handleChainEnd", async () => {
    bulkInsertSpansMock.mockRejectedValueOnce(new Error("db down"));
    const handler = makeHandler();
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
    const handler = makeHandler();
    handler.handleChainStart(fakeSerialized("outer"), {}, "outer", undefined, undefined, {
      langgraph_thread_id: "t-1",
    });
    handler.handleChainStart(fakeSerialized("inner"), {}, "inner", "outer", undefined, {
      langgraph_thread_id: "t-1",
    });
    handler.handleChainEnd({ ok: true }, "inner");
    handler.handleChainEnd({ ok: true }, "outer");
    expect(bulkInsertSpansMock).toHaveBeenCalledTimes(2);
  });

  it("does not call bulkInsert when handleChainEnd is invoked without a matching Start", () => {
    const handler = makeHandler();
    handler.handleChainEnd({ ok: true }, "unknown-run");
    expect(bulkInsertSpansMock).not.toHaveBeenCalled();
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
  it("outermost chain span resolves pmid from inputs.messages; inner LLM span stays null (backfill handles it)", async () => {
    // ponytail: no shared instance state — the outermost chain span
    // resolves pmid from its own inputs.messages via lastHumanMessageId.
    // Inner LLM / tool spans don't receive the outermost messages in
    // their input and don't get per-run metadata propagated by LangChain,
    // so they get null at capture time. bulkInsertSpans' state-fallback
    // backfill fills them at INSERT time from langGraphClient.threads.
    // getState.
    const handler = makeHandler();
    handler.handleChainStart(
      fakeSerialized("CompiledStateGraph"),
      {
        messages: [
          new HumanMessage({ content: "first", id: "h-1" }),
          new HumanMessage({ content: "second", id: "h-2" }),
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

    // bulkInsert fires once per End hook. LLMEnd for llm-1 first
    // (mock.calls[0] = [llm-1 span]), then ChainEnd for outer
    // (mock.calls[1] = [outer span]).
    const llmCall = (bulkInsertSpansMock.mock.calls[0] as unknown as [CapturedSpan[]])[0];
    const chainCall = (bulkInsertSpansMock.mock.calls[1] as unknown as [CapturedSpan[]])[0];
    expect(llmCall[0]?.span_id).toBe("llm-1");
    // inner span: no messages in its input, no per-run metadata → null
    expect(llmCall[0]?.meta.parent_message_id).toBeNull();
    // outermost chain: parsed from inputs.messages
    expect(chainCall[0]?.span_id).toBe("outer");
    expect(chainCall[0]?.meta.parent_message_id).toBe("h-2");
  });

  it("returns null parent_message_id when inputs.messages has no HumanMessage (just V1 envelopes)", async () => {
    // ponytail: the helper relies on `instanceof HumanMessage` — V1
    // envelopes that arrive before the reducer ran are NOT instances
    // and are intentionally missed here. bulkInsertSpans backfills
    // the parent_message_id column from DB on INSERT, so the eventual
    // span row still tags correctly. See lib/langgraph/last-human-
    // message-id.ts docstring for the trade-off.
    const handler = makeHandler();
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

    const flushed = (bulkInsertSpansMock.mock.calls[0] as unknown as [CapturedSpan[]])[0];
    expect(flushed[0]?.meta.parent_message_id).toBeNull();
  });

  it("sets parent_message_id to null when the outermost chain has no human messages", async () => {
    const handler = makeHandler();
    handler.handleChainStart(
      fakeSerialized("CompiledStateGraph"),
      { messages: [] },
      "outer-3",
      undefined,
      undefined,
      { langgraph_thread_id: "t-3" },
    );
    handler.handleChainEnd({ ok: true }, "outer-3");
    const flushed = (bulkInsertSpansMock.mock.calls[0] as unknown as [CapturedSpan[]])[0];
    expect(flushed[0]?.meta.parent_message_id).toBeNull();
  });

  it("clears parent_message_id after the outermost chain ends so the next invoke recomputes", async () => {
    const handler = makeHandler();
    // First invoke: human message h-A
    handler.handleChainStart(
      fakeSerialized("CompiledStateGraph"),
      { messages: [new HumanMessage({ content: "a", id: "h-A" })] },
      "run-A",
      undefined,
      undefined,
      { langgraph_thread_id: "t-4" },
    );
    handler.handleChainEnd({ ok: true }, "run-A");
    // Second invoke: human message h-B
    handler.handleChainStart(
      fakeSerialized("CompiledStateGraph"),
      { messages: [new HumanMessage({ content: "b", id: "h-B" })] },
      "run-B",
      undefined,
      undefined,
      { langgraph_thread_id: "t-4" },
    );
    handler.handleChainEnd({ ok: true }, "run-B");

    // First call: outer-A end → span meta has h-A
    const callA = (bulkInsertSpansMock.mock.calls[0] as unknown as [CapturedSpan[]])[0];
    expect(callA[0]?.meta.parent_message_id).toBe("h-A");
    // Second call: outer-B end → span meta has h-B (not stuck on h-A)
    const callB = (bulkInsertSpansMock.mock.calls[1] as unknown as [CapturedSpan[]])[0];
    expect(callB[0]?.meta.parent_message_id).toBe("h-B");
  });

  // ponytail: kb-upload / background_agent dispatches stamp
  // metadata.parent_message_id via runs.create. The handler should
  // honor that even if inputs.messages would resolve to a different
  // value — metadata is the per-run trigger reference, the messages
  // array may have been augmented by a later write.
  it("metadata.parent_message_id wins over lastHumanMessageId(inputs.messages)", async () => {
    const handler = makeHandler();
    handler.handleChainStart(
      fakeSerialized("CompiledStateGraph"),
      {
        messages: [new HumanMessage({ content: "user-msg", id: "h-from-messages" })],
      },
      "outer-bg",
      undefined,
      undefined,
      { langgraph_thread_id: "t-bg", parent_message_id: "h-from-metadata" },
    );
    handler.handleChainEnd({ ok: true }, "outer-bg");
    const flushed = (bulkInsertSpansMock.mock.calls[0] as unknown as [CapturedSpan[]])[0];
    expect(flushed[0]?.meta.parent_message_id).toBe("h-from-metadata");
  });

  // ponytail: the actual bug we're guarding against. Two concurrent
  // invokes on the same handler instance — outer spans interleave
  // before either ends. Pre-fix, the instance field
  // `currentParentMessageId` would be overwritten by whichever
  // handleChainStart ran last, polluting the other's spans. Post-fix
  // there's no shared state; each handleChainStart resolves from its
  // own inputs.messages.
  it("concurrent invokes don't clobber each other's parent_message_id", async () => {
    const handler = makeHandler();
    // invoke A: outermost h-A
    handler.handleChainStart(
      fakeSerialized("CompiledStateGraph"),
      { messages: [new HumanMessage({ content: "a", id: "h-A" })] },
      "outer-A",
      undefined,
      undefined,
      { langgraph_thread_id: "t-conc" },
    );
    // invoke B arrives before A ends: outermost h-B overwrites the
    // instance field (pre-fix), but A's pmid is already stamped on its
    // span via the per-call resolve.
    handler.handleChainStart(
      fakeSerialized("CompiledStateGraph"),
      { messages: [new HumanMessage({ content: "b", id: "h-B" })] },
      "outer-B",
      undefined,
      undefined,
      { langgraph_thread_id: "t-conc" },
    );
    handler.handleChainEnd({ ok: true }, "outer-A");
    handler.handleChainEnd({ ok: true }, "outer-B");

    const callA = (bulkInsertSpansMock.mock.calls[0] as unknown as [CapturedSpan[]])[0];
    const callB = (bulkInsertSpansMock.mock.calls[1] as unknown as [CapturedSpan[]])[0];
    expect(callA[0]?.meta.parent_message_id).toBe("h-A"); // not h-B
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
    const handler = makeHandler();
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
    const handler = makeHandler();
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
    const handler = makeHandler();
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
    const toolFlushed = (bulkInsertSpansMock.mock.calls[0] as unknown as [CapturedSpan[]])[0];
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
    const handler = makeHandler();
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

    const toolFlushed = (bulkInsertSpansMock.mock.calls[0] as unknown as [CapturedSpan[]])[0];
    const humanFlushed = (bulkInsertSpansMock.mock.calls[1] as unknown as [CapturedSpan[]])[0];
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
    const handler = makeHandler();
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

    expect(bulkInsertSpansMock).toHaveBeenCalledTimes(1);
    const flushed = (bulkInsertSpansMock.mock.calls[0] as unknown as [CapturedSpan[]])[0];
    expect(flushed[0]?.status).toBe("failed");
    expect(flushed[0]?.error).toBe("boom");
  });

  // ponytail: the resume-finalize logic was dropped together with the
  // `openHumanSpanId` field — in-memory state dies on `langgraphjs dev`
  // process restart, so the field is write-only in practice. The human
  // span stays `status: "waiting"` (panel maps to `running`) until
  // something else updates it; that's the deliberate MVP trade-off.

  it("treats a GraphInterrupt bubbling through handleChainError as waiting (wrapper pause, not failed)", () => {
    // ponytail: when `interrupt()` throws, the GraphInterrupt unwinds
    // through every wrapper chain in the call stack — tools RunnableSequence,
    // inner CompiledStateGraph, outer RunnableSequence — each fires
    // handleChainError. The wrappers are NOT failures and NOT
    // completed — the graph is paused waiting for human resume. The
    // status "waiting" matches the synthetic human span (inserted by
    // handleToolError) so the panel renders the entire stack as a
    // single wait gap. The wrapper stays waiting until its OWN
    // handleChainEnd fires (after the user resumes and the chain
    // actually finishes); bulkInsertSpans' backfill only handles the
    // synthetic human span — chains wait for their own end.
    const handler = makeHandler();
    handler.handleChainStart(
      fakeSerialized("RunnableSequence"),
      {},
      "tools-wrapper",
      undefined,
      undefined,
      { langgraph_thread_id: "t-chain-int" },
    );
    handler.handleChainError(interruptError(), "tools-wrapper");

    const flushed = (bulkInsertSpansMock.mock.calls[0] as unknown as [CapturedSpan[]])[0];
    expect(flushed[0]?.span_id).toBe("tools-wrapper");
    expect(flushed[0]?.status).toBe("waiting");
    expect(flushed[0]?.error).toBeNull();
    // ponytail: chain wrapper's ended_at stays null through the
    // interrupt — only the synthetic human span alongside the tool
    // gets stamped. markRunningAsFailed reconciles it on restart when
    // the resume actually fires handleChainEnd.
    expect(flushed[0]?.ended_at).toBeNull();
  });

  it("still treats a non-interrupt chain error as failed", () => {
    // ponytail: regression guard — only GraphInterrupt should bypass
    // the failed status. A regular chain error (e.g. a downstream tool
    // threw something other than interrupt) must still surface as failed.
    const handler = makeHandler();
    handler.handleChainStart(
      fakeSerialized("RunnableSequence"),
      {},
      "chain-fail",
      undefined,
      undefined,
      { langgraph_thread_id: "t-chain-fail" },
    );
    handler.handleChainError(new Error("downstream boom"), "chain-fail");

    const flushed = (bulkInsertSpansMock.mock.calls[0] as unknown as [CapturedSpan[]])[0];
    expect(flushed[0]?.status).toBe("failed");
    expect(flushed[0]?.error).toBe("downstream boom");
  });
});

describe("CapturingHandler — payload trims (Phase 1)", () => {
  it("strips redundant fields from incoming meta before persisting", async () => {
    const handler = makeHandler();
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
    const [spans] = bulkInsertSpansMock.mock.calls[0] as unknown as [CapturedSpan[]];
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
    const handler = makeHandler();
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
    const [spans] = bulkInsertSpansMock.mock.calls[0] as unknown as [CapturedSpan[]];
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
    const handler = makeHandler();
    handler.handleChatModelStart(fakeSerialized("ChatOpenAI"), [messages] as never, runId);
    handler.handleLLMEnd({ generations: [] } as never, runId);
    const [spans] = bulkInsertSpansMock.mock.calls[0] as unknown as [CapturedSpan[]];
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
