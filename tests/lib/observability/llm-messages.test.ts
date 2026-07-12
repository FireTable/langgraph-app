import { describe, it, expect } from "vitest";
import { buildLlmMessages } from "@/components/observability/llm-messages";
import type { CapturedSpan } from "@/lib/observability/callback";

function makeSpan(input: unknown, output: unknown): CapturedSpan {
  return {
    span_id: "s",
    parent_span_id: null,
    name: "weatherModel",
    kind: "llm",
    status: "completed",
    started_at: 0,
    ended_at: 0,
    input,
    output,
    usage: null,
    error: null,
    meta: {},
  };
}

// ponytail: input shape mirrors what LangChain hands us — `prompts` is
// an array of strings, each a newline-joined role-prefixed transcript.
function chatPrompt(...lines: string[]): { prompts: string[] } {
  return { prompts: [lines.join("\n")] };
}

// ponytail: real ChatModel output is `{ generations: [[gen, ...], ...] }`,
// where each gen is `{ message: BaseMessage }`. We only need the fields
// readOutputMessages actually touches (message.content / role / tool_calls).
function aiOutput(...texts: (string | null)[]): { generations: Array<Array<unknown>> } {
  const generations = texts.map((t) => [aiMessage(t)]);
  return { generations };
}

function aiMessage(text: string | null, toolCalls?: unknown[]): unknown {
  const m: Record<string, unknown> = {
    lc: 1,
    type: "constructor",
    id: ["langchain_core", "messages", "ai", "AIMessage"],
    kwargs: { content: text },
  };
  m.getType = () => "ai";
  m.role = "assistant";
  if (text != null) m.content = text;
  if (toolCalls) {
    m.content = "";
    m.tool_calls = toolCalls;
  }
  return {
    text: text ?? "",
    message: m,
  };
}

describe("buildLlmMessages — original semantics (cumulative NEW across calls)", () => {
  it("marks every entry from the last human onward in input + every output as NEW", () => {
    const span = makeSpan(
      chatPrompt("system: you are a helper", "human: hello"),
      aiOutput("hi back"),
    );
    const out = buildLlmMessages(span);
    expect(out).toHaveLength(3);
    // ponytail: original behavior — input entries from lastHuman
    // onward (here, just the human) + every output entry.
    expect(out.filter((e) => e.isNew)).toHaveLength(2);
    expect(out[0].isNew).toBeUndefined();
    expect(out[1]).toMatchObject({ role: "human", isNew: true });
    expect(out[2]).toMatchObject({ role: "ai", isNew: true });
  });

  it("carries intermediate AI / tool rows from prior LLM calls as NEW too", () => {
    // ponytail: per the reverted semantics, the second LLM call's
    // input is the user's *latest* human + the AI/tool history from
    // the first call. Every entry from lastHuman onward is NEW, which
    // means the count grows across LLM calls in a turn (intentional).
    const span = makeSpan(
      chatPrompt(
        "system: you are a helper",
        "human: hello",
        "ai: I'll check the weather",
        "tool: 72F sunny",
      ),
      aiOutput("It's 72F and sunny today."),
    );
    const out = buildLlmMessages(span);
    // 3 input from lastHuman onward (human, ai, tool) + 1 output = 4 NEW.
    expect(out.filter((e) => e.isNew)).toHaveLength(4);
    expect(out.filter((e) => !e.isNew)).toHaveLength(1);
    expect(out[0].isNew).toBeUndefined();
  });

  it("marks every output generation as NEW when the LLM returns multiple samples", () => {
    const span = makeSpan(
      chatPrompt("system: be terse", "human: hi"),
      aiOutput("hello 1", "hello 2", "hello 3"),
    );
    const out = buildLlmMessages(span);
    // 1 input (human) + 3 output = 4 NEW.
    expect(out.filter((e) => e.isNew)).toHaveLength(4);
    expect(out.find((e) => e.body === "hello 1")?.isNew).toBe(true);
    expect(out.find((e) => e.body === "hello 3")?.isNew).toBe(true);
  });

  it("marks every input entry NEW when the input has no human message (i >= -1 is always true)", () => {
    const span = makeSpan(chatPrompt("system: you are a tool"), aiOutput("ok"));
    const out = buildLlmMessages(span);
    // ponytail: original semantics — lastHumanIdx = -1, so the
    // `i >= lastHumanIdx` predicate catches every input entry. This
    // is the cumulative-count behavior the user explicitly asked to
    // keep (don't suppress the system row in absence of a human).
    expect(out.filter((e) => e.isNew)).toHaveLength(2);
    expect(out[0].isNew).toBe(true);
    expect(out[1].isNew).toBe(true);
  });
});
