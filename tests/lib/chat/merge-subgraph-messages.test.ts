import { describe, expect, it } from "vitest";

// ponytail: input is structural (any object with an optional id) so the
// helper is reusable for BaseMessage, plain SDK message rows, and
// checkpoint-store records without coupling to @langchain/core.
type Row = { id?: string; payload?: unknown };
type TaskLike = { state?: { values?: { messages?: Row[] } } };

// Lazy import so a missing module produces a clear test failure.
import { mergeSubgraphMessages } from "@/lib/langgraph/merge-subgraph-messages";

describe("mergeSubgraphMessages", () => {
  it("returns the parent list untouched when no tasks carry subgraph state", () => {
    const parent: Row[] = [{ id: "a" }, { id: "b" }];
    expect(mergeSubgraphMessages(parent, [])).toEqual(parent);
    expect(mergeSubgraphMessages(parent, undefined)).toEqual(parent);
    expect(mergeSubgraphMessages(parent, [{ state: undefined }])).toEqual(parent);
    expect(mergeSubgraphMessages(parent, [{ state: { values: {} } }])).toEqual(parent);
    expect(mergeSubgraphMessages(parent, [{ state: { values: { messages: [] } } }])).toEqual(parent);
  });

  it("appends subgraph-only messages to the parent list in chronological order", () => {
    const parent: Row[] = [
      { id: "u1", payload: "user" },
      { id: "r1", payload: "router" },
    ];
    const tasks: TaskLike[] = [
      {
        state: {
          values: {
            messages: [
              { id: "u1", payload: "user" }, // initial copy from parent
              { id: "r1", payload: "router" },
              { id: "a1", payload: "ai+tool_call" }, // new in subgraph
              { id: "t1", payload: "tool" }, // new in subgraph
            ],
          },
        },
      },
    ];
    expect(mergeSubgraphMessages(parent, tasks)).toEqual([
      { id: "u1", payload: "user" },
      { id: "r1", payload: "router" },
      { id: "a1", payload: "ai+tool_call" },
      { id: "t1", payload: "tool" },
    ]);
  });

  it("picks the last task's subgraph state (matches SDK's tasks.at(-1) convention)", () => {
    const parent: Row[] = [{ id: "u1" }];
    const tasks: TaskLike[] = [
      { state: { values: { messages: [{ id: "u1" }, { id: "stale" }] } } },
      { state: { values: { messages: [{ id: "u1" }, { id: "fresh" }] } } },
    ];
    const merged = mergeSubgraphMessages(parent, tasks);
    expect(merged.map((r) => r.id)).toEqual(["u1", "fresh"]);
  });

  it("falls back to the parent list when the subgraph slice is shorter than parent", () => {
    const parent: Row[] = [{ id: "u1" }, { id: "r1" }, { id: "a1" }];
    const tasks: TaskLike[] = [{ state: { values: { messages: [{ id: "u1" }] } } }];
    expect(mergeSubgraphMessages(parent, tasks)).toEqual(parent);
  });

  it("deduplicates by id — duplicate ids inside the subgraph slice are kept once", () => {
    const parent: Row[] = [{ id: "u1" }];
    const tasks: TaskLike[] = [
      {
        state: {
          values: {
            messages: [
              { id: "u1" },
              { id: "a1" },
              { id: "a1", payload: "duplicate" },
              { id: "t1" },
            ],
          },
        },
      },
    ];
    const merged = mergeSubgraphMessages(parent, tasks);
    expect(merged.map((r) => r.id)).toEqual(["u1", "a1", "t1"]);
    expect(merged[1]?.payload).toBeUndefined(); // first occurrence wins
  });

  it("passes through id-less rows without using them as dedupe keys", () => {
    const parent: Row[] = [{ id: "u1" }, { payload: "anonymous" }];
    const tasks: TaskLike[] = [
      {
        state: {
          values: {
            messages: [{ id: "u1" }, { payload: "anonymous" }, { id: "a1" }],
          },
        },
      },
    ];
    const merged = mergeSubgraphMessages(parent, tasks);
    expect(merged).toEqual([
      { id: "u1" },
      { payload: "anonymous" },
      { payload: "anonymous" }, // anonymous rows are not deduped by id
      { id: "a1" },
    ]);
  });

  it("returns the subgraph slice when parent is empty but subgraph has rows", () => {
    const tasks: TaskLike[] = [
      { state: { values: { messages: [{ id: "u1" }, { id: "a1" }] } } },
    ];
    expect(mergeSubgraphMessages([], tasks)).toEqual([{ id: "u1" }, { id: "a1" }]);
  });
});