import { describe, expect, it } from "vitest";
import type { SummaryEntry } from "@/lib/memory/validators";
import { groupThreadsByThreadId } from "@/components/settings/memory-view";

type ThreadRow = {
  key: string;
  value: SummaryEntry;
  threadTitle: string | null;
};

function summary(threadId: string, sequence: number, createdAt: string): ThreadRow {
  return {
    key: `${threadId}:${sequence}`,
    value: {
      threadId,
      sequence,
      startMessageIndex: 0,
      endMessageIndex: 0,
      messageCount: 1,
      messageIds: ["m0"],
      summary: { entries: [{ question: "q", answer: "a", refs: ["1"] }] },
      triggerReason: "turn_based" as const,
      tokenCountBefore: 0,
      tokenCountAfter: 0,
      createdAt,
    },
    threadTitle: `Title ${threadId}`,
  };
}

describe("groupThreadsByThreadId", () => {
  it("returns [] for empty input", () => {
    expect(groupThreadsByThreadId([])).toEqual([]);
  });

  it("groups multiple summaries under the same threadId", () => {
    const out = groupThreadsByThreadId([
      summary("t1", 1, "2026-07-02T00:00:00.000Z"),
      summary("t1", 2, "2026-07-02T01:00:00.000Z"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.threadId).toBe("t1");
    expect(out[0]?.summaries).toHaveLength(2);
    expect(out[0]?.threadTitle).toBe("Title t1");
  });

  it("sorts thread groups by the latest summary's createdAt desc", () => {
    // ponytail: most-recently-active thread first. Within a thread
    // summaries are append-only, so max(createdAt) across the
    // group's summaries == the latest trigger time. The chat list
    // uses the same recency ordering, so the Memory tab matches.
    const out = groupThreadsByThreadId([
      summary("old", 1, "2026-06-01T00:00:00.000Z"),
      summary("newest", 1, "2026-07-05T00:00:00.000Z"),
      summary("middle", 1, "2026-07-01T00:00:00.000Z"),
    ]);
    expect(out.map((g) => g.threadId)).toEqual(["newest", "middle", "old"]);
  });

  it("uses max(createdAt) — a thread's most recent summary drives its position", () => {
    // t1 has an old summary + a recent one; t2 only has an old
    // summary. t1 must come first even though its first summary
    // is older than t2's.
    const out = groupThreadsByThreadId([
      summary("t1", 1, "2025-01-01T00:00:00.000Z"),
      summary("t1", 2, "2026-07-05T00:00:00.000Z"),
      summary("t2", 1, "2026-01-01T00:00:00.000Z"),
    ]);
    expect(out.map((g) => g.threadId)).toEqual(["t1", "t2"]);
  });

  it("preserves threadTitle (first-wins across the group)", () => {
    const out = groupThreadsByThreadId([
      { ...summary("t1", 1, "2026-07-01T00:00:00.000Z"), threadTitle: "first" },
      { ...summary("t1", 2, "2026-07-02T00:00:00.000Z"), threadTitle: "second" },
    ]);
    expect(out[0]?.threadTitle).toBe("first");
  });

  it("preserves a null threadTitle (pre-rename threads)", () => {
    const out = groupThreadsByThreadId([
      { ...summary("t1", 1, "2026-07-01T00:00:00.000Z"), threadTitle: null },
    ]);
    expect(out[0]?.threadTitle).toBeNull();
  });
});
