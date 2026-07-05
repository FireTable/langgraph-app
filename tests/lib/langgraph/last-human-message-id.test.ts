import { describe, it, expect } from "vitest";
import { HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import { lastHumanMessageId } from "@/lib/langgraph/last-human-message-id";

describe("lastHumanMessageId", () => {
  it("returns null for non-array input", () => {
    expect(lastHumanMessageId(null)).toBeNull();
    expect(lastHumanMessageId(undefined)).toBeNull();
    expect(lastHumanMessageId({})).toBeNull();
    expect(lastHumanMessageId("not an array")).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(lastHumanMessageId([])).toBeNull();
  });

  it("reads id from a HumanMessage instance", () => {
    expect(lastHumanMessageId([new HumanMessage({ content: "hi", id: "h-1" })])).toBe("h-1");
  });

  it("returns the id of the LAST HumanMessage, scanning backwards", () => {
    expect(
      lastHumanMessageId([
        new HumanMessage({ content: "first", id: "h-1" }),
        new AIMessage({ content: "ack", id: "a-1" }),
        new HumanMessage({ content: "second", id: "h-2" }),
      ]),
    ).toBe("h-2");
  });

  it("skips trailing ai/tool/system messages and walks backwards to the prior human", () => {
    expect(
      lastHumanMessageId([
        new HumanMessage({ content: "h", id: "h-1" }),
        new AIMessage({ content: "a", id: "a-1" }),
        new ToolMessage({ content: "t", tool_call_id: "tc-1", id: "t-1" }),
      ]),
    ).toBe("h-1");
  });

  it("returns null when the only human message has no id", () => {
    expect(lastHumanMessageId([new HumanMessage({ content: "no id" })])).toBeNull();
  });

  it("returns null for V1 envelopes — they're a serialization artifact, reducer normalizes them", () => {
    // ponytail: the old helper peeled envelopes manually. The new
    // version relies on the reducer having already run by the time we
    // see messages — bulkInsertSpans backfills the parent_message_id
    // column from DB for any span that lands here with null. So this
    // case is intentionally a miss; the docstring in the helper
    // explains the trade-off.
    expect(
      lastHumanMessageId([
        {
          lc: 1,
          type: "constructor",
          id: ["langchain_core", "messages", "HumanMessage"],
          kwargs: { type: "human", id: "h-envelope", content: "hi" },
        },
      ]),
    ).toBeNull();
  });

  it("skips null / non-object rows without throwing", () => {
    expect(
      lastHumanMessageId([
        null,
        undefined,
        "string",
        42,
        new HumanMessage({ content: "hi", id: "h-5" }),
      ]),
    ).toBe("h-5");
  });
});
