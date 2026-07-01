import { describe, it, expect, vi } from "vitest";
import type { Serialized } from "@langchain/core/load/serializable";
import { CapturingHandler } from "@/backend/observability/callback-collector";
import type { CapturedSpan } from "@/backend/observability/callback-collector";

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
