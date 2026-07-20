import type { SummaryEntries } from "@/lib/langgraph/summary-schema";

// ponytail: pure display renderer — entries → the "#N, #M Q: ... A: ..."
// text the model reads in the <threads> system block and the user reads
// in the Memory tab. Lives in lib/ (not backend/) so both server-side
// prompt builders and client-side UI import the SAME formatter — drift
// would surface as a visual difference between the model's view and the
// user's view of the same stored summary.
//
// Format: each entry is `#N, #M Q: ... \n   A: ...`, entries separated
// by a blank line. Whitespace matches the @assistant-ui markdown
// renderer (3-space indent on the A line so the continuation lines up
// under Q).
//
// ponytail: refs are stored as raw integer/identifier strings (e.g.
// "1", "1-3") — we add the leading `#` here so callers don't have to
// remember to include it. The prompt's THREAD_SUMMARIZE_PROMPT
// instructions say "use this #N verbatim in OUTPUT refs" — that's
// the model-side contract; storage stays plain.
export function formatSummaryText(entries: SummaryEntries): string {
  return entries
    .map((e) => {
      const refs = e.refs.map((r) => (r.startsWith("#") ? r : `#${r}`)).join(", ");
      return `${refs}
Q: ${e.question}
A: ${e.answer}`;
    })
    .join("\n\n");
}
