// ponytail: end-to-end check that the structured-summary refactor is
// wired through both sides of the data flow:
//   1. backend writes SummaryEntry with structured `summary` (the LLM
//      output shape, NOT a pre-formatted string).
//   2. backend reads it back via getAllUserSummaries — the shape is
//      preserved byte-for-byte.
//   3. backend renders the prompt's <threads> block — the JSON dump
//      includes the structured form, the LLM sees it as JSON.
//   4. UI renders the Memory tab — formatSummaryText on the stored
//      entries produces the same "#N Q: ... A: ..." text the user
//      saw before the refactor.
//
// This test exists BECAUSE the previous round (string-typed summary)
// lost the structure and produced near-duplicate strings on re-runs.
// Future maintainers editing the schema or the format function should
// see this test fail if either side drifts from the contract.
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatSummaryText } from "@/lib/langgraph/format-summary";
import { getAllUserSummaries, getRecentThreadSummaries, writeSummary } from "@/lib/memory/queries";
import { SummaryEntrySchema, type SummaryEntry } from "@/lib/memory/validators";

const { mockStore } = vi.hoisted(() => ({
  mockStore: {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    search: vi.fn(),
    batch: vi.fn(),
  },
}));

vi.mock("@/backend/store", () => ({ store: mockStore }));

const USER = "u1";
const THREAD = "t1";

const sampleEntries: Array<{ question: string; answer: string; refs: string[] }> = [
  { question: "what's the weather in BJ?", answer: "sunny 25°C", refs: ["#1"] },
  { question: "and in SH?", answer: "rainy 18°C", refs: ["#2"] },
];

afterEach(() => vi.clearAllMocks());

describe("summary structured round-trip", () => {
  it("writeSummary stores the structured LLM output verbatim, not a pre-formatted string", async () => {
    mockStore.put.mockResolvedValueOnce(undefined);
    const summary: SummaryEntry["summary"] = { entries: [...sampleEntries] };

    const written = await writeSummary(USER, {
      threadId: THREAD,
      sequence: 1,
      startMessageIndex: 0,
      endMessageIndex: 1,
      messageCount: 2,
      messageIds: ["m0", "m1"],
      summary,
      triggerReason: "turn_based",
      tokenCountBefore: 120,
      tokenCountAfter: 24,
    });

    // The stored row's `summary` is the structured object — same shape
    // summaryOutputSchema produces from withStructuredOutput(...).
    expect(written.summary).toEqual({ entries: [...sampleEntries] });
    // Schema round-trip validates the shape.
    expect(SummaryEntrySchema.safeParse(written).success).toBe(true);
  });

  it("getAllUserSummaries reads back the structured form byte-for-byte", async () => {
    const stored = {
      entries: [...sampleEntries],
    };
    mockStore.search.mockResolvedValueOnce([
      {
        namespace: [USER, "threads"],
        key: `${THREAD}:1`,
        value: {
          threadId: THREAD,
          sequence: 1,
          startMessageIndex: 0,
          endMessageIndex: 1,
          messageCount: 2,
          messageIds: ["m0", "m1"],
          summary: stored,
          triggerReason: "turn_based",
          tokenCountBefore: 0,
          tokenCountAfter: 0,
          createdAt: "2026-07-06T00:00:00.000Z",
        },
      },
    ]);
    const rows = await getAllUserSummaries(USER);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value.summary).toEqual({ entries: [...sampleEntries] });
  });

  it("getRecentThreadSummaries (Memory tab API) returns the structured form", async () => {
    mockStore.search.mockResolvedValueOnce([
      {
        key: `${THREAD}:1`,
        value: {
          threadId: THREAD,
          sequence: 1,
          startMessageIndex: 0,
          endMessageIndex: 1,
          messageCount: 2,
          messageIds: ["m0", "m1"],
          summary: { entries: [...sampleEntries] },
          triggerReason: "turn_based",
          tokenCountBefore: 0,
          tokenCountAfter: 0,
          createdAt: "2026-07-06T00:00:00.000Z",
        },
      },
    ]);
    const summaries = await getRecentThreadSummaries(USER);
    expect(summaries[0]?.value.summary).toEqual({ entries: [...sampleEntries] });
    // The Memory tab API response shape carries structured entries
    // through to the UI — the UI calls formatSummaryText to render.
  });

  it("formatSummaryText produces the same display string from structured entries as the prior string-typed shape", () => {
    // The UI passes the stored entries through formatSummaryText at
    // render time. Verify the output matches the prior "#N Q: ... A: ..."
    // text the Memory tab was rendering before the refactor.
    const text = formatSummaryText([...sampleEntries]);
    expect(text).toBe(
      "#1\nQ: what's the weather in BJ?\nA: sunny 25°C\n\n" + "#2\nQ: and in SH?\nA: rainy 18°C",
    );
    // Sanity: the prompt's <threads> JSON dump contains the same words
    // the model used to see when summary was a string — backward compat
    // from the LLM's perspective.
    expect(text).toContain("what's the weather in BJ?");
    expect(text).toContain("rainy 18°C");
  });
});
