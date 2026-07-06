import { z } from "zod";

// ponytail: structured summary = the same shape the LLM produces
// via withStructuredOutput(summaryOutputSchema). Stored verbatim to
// the SummaryEntry.summary field. Storing the structured form
// (instead of a pre-formatted text) lets later passes compare / merge
// / dedupe across re-runs — once you flatten to text the structure
// is gone and you get N near-duplicate strings for the same Q&A.
//
// The LLM output is wrapped in `{ entries: [...] }` rather than
// bare-array so the schema is the SAME type as the LLM's response,
// making it round-trip safe: what comes out of withStructuredOutput
// is what gets written, no field renaming needed.

const summaryEntryShape = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  refs: z.array(z.string().min(1)).min(1),
});

export const SummaryEntriesSchema = z.array(summaryEntryShape).min(1);

export const summaryOutputSchema = z.object({
  entries: SummaryEntriesSchema,
});

export type SummaryEntryShape = z.infer<typeof summaryEntryShape>;
export type SummaryEntries = z.infer<typeof SummaryEntriesSchema>;
export type SummaryOutput = z.infer<typeof summaryOutputSchema>;
