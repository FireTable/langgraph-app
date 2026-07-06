// ponytail: one-shot seed for verifying the structured-summary refactor
// end-to-end. Writes a real SummaryEntry (structured form) to the
// LangGraph store for the given userId/threadId, then the dev server's
// /api/memory/threads (and the Memory tab UI) can read it back.
//
// Run: pnpm exec tsx scripts/seed-summary.ts <userId> <threadId>
import { writeSummary } from "@/lib/memory/queries";

const userId = process.argv[2];
const threadId = process.argv[3];
if (!userId || !threadId) {
  console.error("usage: tsx scripts/seed-summary.ts <userId> <threadId>");
  process.exit(1);
}

const summary = {
  entries: [
    {
      question: "what's the weather in BJ?",
      answer: "sunny 25°C, light breeze",
      refs: ["#1"],
    },
    {
      question: "and in SH?",
      answer: "rainy 18°C, expect showers through the evening",
      refs: ["#2"],
    },
    {
      question: "should I bring an umbrella?",
      answer: "yes for SH, no for BJ",
      refs: ["#3"],
    },
  ],
};

const written = await writeSummary(userId, {
  threadId,
  sequence: 1,
  startMessageIndex: 0,
  endMessageIndex: 2,
  messageCount: 3,
  messageIds: ["m0", "m1", "m2"],
  summary,
  triggerReason: "turn_based",
  tokenCountBefore: 220,
  tokenCountAfter: 48,
});

console.log("seeded structured summary:", JSON.stringify(written, null, 2));
