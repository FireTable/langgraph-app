import type { SummaryEntries } from "@/lib/langgraph/summary-schema";

// ponytail: pure display renderer — entries → the "#N, #M Q: ... A: ..."
// text the model reads in the <threads> system block and the user reads
// in the Memory tab. Lives in lib/ (not backend/) so both server-side
// prompt builders and client-side UI import the SAME formatter — drift
// would surface as a visual difference between the model's view and the
// user's view of the same stored summary.
//
// Format: each entry is `${refs.join(", ")} Q: ${question}\n   A: ${answer}`,
// entries separated by a blank line. Whitespace matches the
// @assistant-ui markdown renderer (3-space indent on the A line so the
// continuation lines up under Q).
export function formatSummaryText(entries: SummaryEntries): string {
  return entries
    .map((e) => {
      const refs = e.refs.join(", ");
      return `${refs}
Q: ${e.question}
A: ${e.answer}`;
    })
    .join("\n\n");
}
