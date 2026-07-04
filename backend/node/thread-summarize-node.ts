import { z } from "zod";

import {
  MEMORY_THREAD_SUMMARY_BATCH_SIZE,
  MEMORY_THREAD_SUMMARY_KEEP_RECENT,
} from "@/lib/memory/constants";
import { getAllUserSummaries, writeSummary } from "@/lib/memory/queries";
import { chatModel } from "@/backend/model";
import { THREAD_SUMMARIZE_PROMPT } from "@/backend/prompt/system";


type ExcerptMessage = {
  id?: string;
  type?: string;
  content?: unknown;
};

type Config = { configurable?: { userId?: unknown; thread_id?: unknown } };

// ponytail: the LLM produces ordered Q&A entries with refs to the
// #N labels we generated in the prompt. ref strings are the labels
// (e.g. "#1", "#2-#4") — the original BaseMessage.id values are
// resolved programmatically by the node (the messageIds field on
// the SummaryEntry) and never reach the LLM.
const summaryOutputSchema = z.object({
  entries: z
    .array(
      z.object({
        question: z.string().min(1),
        answer: z.string().min(1),
        refs: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
});

const KEEPABLE_TYPES = new Set(["human", "ai", "assistant", "tool", "function"]);

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in (part as object)
          ? String((part as Record<string, unknown>).text ?? "")
          : "",
      )
      .filter(Boolean)
      .join(" ");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

function roleLabel(t: string | undefined): string {
  switch (t) {
    case "human":
      return "User";
    case "ai":
    case "assistant":
      return "Assistant";
    case "tool":
      return "Tool";
    case "function":
      return "Function";
    default:
      return t ?? "Other";
  }
}

function formatSummaryText(
  entries: Array<{ refs: string[]; question: string; answer: string }>,
): string {
  const body = entries
    .map((e) => {
      const refs = e.refs.join(", ");
      return `${refs} Q: ${e.question}\n   A: ${e.answer}`;
    })
    .join("\n\n");
  return [
    "[Earlier conversation compressed into Q&A — #N markers refer to the original turn positions, not the current turn]",
    "",
    body,
  ].join("\n");
}

// ponytail: computes the [startIdx..endIdx] window of HUMAN-ONLY turn
// indices to compress THIS turn.
//
// Boundaries are HUMAN turns, not raw messages. startIdx / endIdx
// index into the human-filtered sequence (the array positions of
// `type === "human"` messages); the actual excerpt later extends to
// capture every AI/tool reply between humanIndices[startIdx] and
// humanIndices[endIdx]. So BATCH_SIZE=6 means "6 human turns per
// batch", not "6 raw messages" — a batch of 6 humans with 10
// interleaved AI/tool calls still compresses to 6 Q&As.
//
//   startIdx = (lastEndIndex ?? -1) + 1           // continue prior run
//   endIdx   = min(startIdx + BATCH_SIZE - 1,
//                  userMessageCount - KEEP_RECENT - 1)
//                                                  // never trample recent
//
// Returns null when there's no work to do (caller drains the route by
// returning END before reaching the node — but the node re-derives
// here because the router's snapshot can be one step stale).
function computeWindow(
  humanCount: number,
  lastEndIndex: number | null,
): { startIdx: number; endIdx: number } | null {
  if (humanCount <= MEMORY_THREAD_SUMMARY_KEEP_RECENT) return null;
  const startIdx = (lastEndIndex ?? -1) + 1;
  const maxEndIdx = humanCount - MEMORY_THREAD_SUMMARY_KEEP_RECENT - 1;
  const idealEndIdx = startIdx + MEMORY_THREAD_SUMMARY_BATCH_SIZE - 1;
  const endIdx = Math.min(idealEndIdx, maxEndIdx);
  if (endIdx < startIdx) return null;
  return { startIdx, endIdx };
}

// ponytail: side-effect-only node. Runs the LLM compression, persists
// the SummaryEntry to the store, returns an empty state update. The
// messages channel is intentionally NOT touched: removing original
// turns would erase user-visible history ("where did my messages go?"),
// and injecting a synthetic HumanMessage would render in the chat as
// a phantom user turn ("I didn't say that"). Both rejected during
// review. The summary lives ONLY in the store — the Memory tab
// displays it; future rehydration can map it back to specific turns
// via the human-only messageIds field. Context-window trimming is a
// separate concern, not this node's job.
//
// The batch boundary is HUMAN turns, not raw messages: a window of N
// humans covers N + (all interleaved AI/tool/function) messages in
// the excerpt, and the LLM is expected to produce N Q&As (one per
// human). See computeWindow above.
//
// Defensive gates mirror shouldSummarizeRouter so a stale router
// snapshot can't drive the node into a malformed write.
export async function threadSummarizeNode(
  state: { messages?: Array<ExcerptMessage> },
  config: Config,
): Promise<{ messages: never[] }> {
  const userId = config.configurable?.userId;
  const threadId = config.configurable?.thread_id;
  // ponytail: the router would have END'd when these are missing, but
  // re-derive defensively — the conditional edge function and the node
  // body can race across ticks when the LLM completes mid-snapshot.
  if (typeof userId !== "string" || userId.length === 0) return { messages: [] };
  if (typeof threadId !== "string" || threadId.length === 0) return { messages: [] };

  const messages = (state.messages ?? []) as Array<ExcerptMessage>;
  const humanIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.type === "human") humanIndices.push(i);
  }

  // ponytail: cheap necessary-condition check first — same logic as
  // shouldSummarizeRouter. The router already gated, but the
  // condition can race (a turn can land between router and node), so
  // re-deriving locally is the safety belt AND avoids a needless
  // store scan when the thread hasn't crossed KEEP_RECENT yet.
  if (humanIndices.length <= MEMORY_THREAD_SUMMARY_KEEP_RECENT) return { messages: [] };

  const allSummaries = await getAllUserSummaries(userId);
  const latest = allSummaries
    .filter((s) => s.value.threadId === threadId)
    .sort((a, b) => b.value.sequence - a.value.sequence)[0];

  const window = computeWindow(humanIndices.length, latest?.value.endMessageIndex ?? null);
  if (!window) return { messages: [] };
  const { startIdx, endIdx } = window;

  // ponytail: build the excerpt from the closed human-only interval,
  // then keep only roles the LLM should see for compression (skip
  // orphan / unknown types). The slice extends 1 past the last human
  // index so an assistant reply at the tail of the batch is included.
  const excerptStart = humanIndices[startIdx];
  const excerptEnd = humanIndices[endIdx];
  const excerpt: ExcerptMessage[] = [];
  for (let i = excerptStart; i <= excerptEnd; i++) {
    const m = messages[i];
    if (!m) continue;
    const t = m.type;
    if (t && KEEPABLE_TYPES.has(t)) excerpt.push(m);
  }
  if (excerpt.length === 0) return { messages: [] };

  // Build the numbered transcript (#1..#N for the LLM).
  const transcript = excerpt
    .map((m, i) => `#${i + 1} ${roleLabel(m.type)}: ${stringifyContent(m.content)}`)
    .join("\n\n");

  const out = await chatModel
    .withStructuredOutput(summaryOutputSchema, { method: "jsonSchema" })
    .invoke(
      [
        { role: "system", content: THREAD_SUMMARIZE_PROMPT },
        { role: "user", content: transcript },
      ] as never,
      {
        tags: ["nostream"],
      },
    );

  // ponytail: an empty `entries` (LLM skipped everything) means there's
  // nothing to persist. Empty state update, no SummaryEntry written.
  if (!out.entries || out.entries.length === 0) return { messages: [] };

  const summaryText = formatSummaryText(out.entries);

  // ponytail: parallel id array — one entry per COVERED HUMAN turn, so
  // messageIds.length === messageCount (the schema's closed-interval
  // refine). AI/tool interleaving is excluded — the original messages
  // still live in the channel and can be looked up via the LangGraph
  // checkpointer when rehydration needs them.
  const humanMessageIds: string[] = excerpt
    .filter((m) => m.type === "human")
    .map((m) => m.id ?? "");

  await writeSummary(userId, {
    threadId,
    sequence: (latest?.value.sequence ?? 0) + 1,
    startMessageIndex: startIdx,
    endMessageIndex: endIdx,
    messageCount: endIdx - startIdx + 1,
    messageIds: humanMessageIds,
    summary: summaryText,
  });

  // ponytail: empty state update — the messages channel is left alone.
  // The summary is durable via the store; the chat thread reads the
  // original turns exactly as the user wrote them.
  return { messages: [] };
}
