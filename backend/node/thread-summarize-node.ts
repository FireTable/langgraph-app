import { z } from "zod";

import { MEMORY_THREAD_SUMMARY_KEEP_RECENT } from "@/lib/memory/constants";
import { getAllUserSummaries, writeSummary } from "@/lib/memory/queries";
import { chatModel } from "@/backend/model";
import { THREAD_SUMMARIZE_PROMPT } from "@/backend/prompt/system";
import { HumanMessage, BaseMessage } from "@langchain/core/messages";

function isHumanMessage(m: BaseMessage | ExcerptMessage): boolean {
  return m instanceof HumanMessage || m.type === "human";
}

type ExcerptMessage = {
  id?: string;
  type?: string;
  content?: unknown;
  tool_calls?: unknown;
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

// ponytail: rough char-to-token estimate (~4 chars/token). Only used for
// the SummaryEntry's analytics fields (tokenCountBefore/After) — the
// trigger itself is turn-count-based, NOT token-budget-gated. A future
// token-based secondary pass can swap in @langchain/core's real
// counting without changing the call sites.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateTokensFromExcerpt(excerpt: Array<ExcerptMessage>): number {
  let total = 0;
  for (const m of excerpt) total += estimateTokens(stringifyContent(m.content));
  return total;
}

function formatSummaryText(
  entries: Array<{ refs: string[]; question: string; answer: string }>,
): string {
  const body = entries
    .map((e) => {
      const refs = e.refs.join(", ");
      return `${refs}\n Q: ${e.question}\n   A: ${e.answer}`;
    })
    .join("\n\n");
  return body;
}

// ponytail: "#N" labels are GLOBAL humanIndex (0-indexed), not
// slice-local. This matches SummaryEntry.startMessageIndex /
// endMessageIndex byte-for-byte — the LLM's `refs: ["#3", "#4", "#5"]`
// output maps directly to the Memory tab's `messages [3..5]` range
// without any off-by-one in the read path. The slice-local variant
// was wrong: the LLM produced #1/#2/#3 inside a [3..5] chunk and the
// user had to mentally translate, which also leaked into the model's
// behavior (it treated each slice as a fresh Q&A session rather than
// a continuation). startHumanIdx is the first humanIndex in the slice
// (== computeCumulativeWindow's startIdx).
function normalizeRole(t: string | undefined): "user" | "assistant" | "tool" {
  switch (t) {
    case "human":
      return "user";
    case "tool":
    case "function":
      return "tool";
    default:
      return "assistant";
  }
}

// ponytail: JSONL output — one line per human turn in the THREAD, 1-indexed
// globally. The LLM reads each line as a self-contained record and emits
// OUTPUT entries whose `refs` map 1:1 back to these id strings (matches
// SummaryEntry.startMessageIndex..endMessageIndex byte-for-byte in the new
// 1-indexed world — Memory tab display "messages [3..5]" → humanIndex 2..4
// under the cumulative formula, and the LLM's `refs: ["#3"..."#5"]` reuses
// that exact id, so the read path stays structural). Replacing the prior
// markdown "#N\nUser: ...\nAssistant: ..." format — role labels in plain
// text collided with content containing ":" and tool_calls had to be
// appended as ad-hoc "[tool_call X]" trailers that the model often
// ignored, producing the meta-question paraphrase ("User said … what was
// the assistant's response?"). Structured input ↔ structured output
// eliminates the prose↔JSON translation step on the model side.
function renderTranscript(excerpt: Array<ExcerptMessage>, startHumanIdx: number): string {
  const lines: string[] = [];
  let humanCount = 0;
  let current: { id: string; messages: unknown[] } | null = null;
  const flush = () => {
    if (current !== null) lines.push(JSON.stringify(current));
    current = null;
  };
  for (const m of excerpt) {
    if (isHumanMessage(m)) {
      flush();
      humanCount++;
      current = { id: `#${startHumanIdx + humanCount}`, messages: [] };
    }
    if (!current) continue;

    const msg: { role: string; content: unknown; tool_calls?: unknown } = {
      role: normalizeRole(m.type),
      content: stringifyContent(m.content) || "",
    };
    // ponytail: carry tool_calls as a first-class field. Models trained on
    // log-style JSONL iterate it naturally and don't drop it like they
    // drop trailing "[tool_call X]" prose — the prior format's missing
    // tool_call lines were the root cause of the meta-question paraphrase
    // failures in #3..#5 chunks (see issue notes 2026-07-04).
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      msg.tool_calls = m.tool_calls;
    }
    current.messages.push(msg);
  }
  flush();
  return lines.join("\n");
}

// ponytail: STORE-ANCHORED trigger (replaces the prior stateless
// `(humanCount-1) % KEEP_RECENT === 0` formula). The store is the
// source of truth for "what's already compressed" —
// lastCompressedEndIdx reads back the max endMessageIndex across
// this thread's SummaryEntries. Pure formula-only triggers can't
// survive a user delete or a replay: rolling the chat back /
// emptying the Memory tab / replaying old turns would re-fire on
// the same window. Store-anchored heals all three.
//
// Trigger rule: when ≥ KEEP_RECENT new humans have accumulated
// past lastCompressedEndIdx, write one KEEP_RECENT-sized chunk
// starting at lastCompressedEndIdx+1. After deletion the
// lastCompressedEndIdx drops back to -1 and the next trigger
// re-emits the earliest missing chunk — no "holes" in coverage.
// Multiple triggers stack if the user keeps deleting.
//
// Patterns (KEEP_RECENT=3):
//   Fresh:     round  4 → [0..2], then quiet until round  6 → [3..5],
//              round 9 → [6..8], ... (4, 6, 9, 12, ... = every 3 after K+1)
//   Deletion:  user empties Memory tab → lastEnd=-1, next trigger
//              re-writes [0..2], then continues with [3..5], [6..8].
//
// Callsite reads each row of getAllUserSummaries once and threads
// the result through both the trigger decision and the
// sequence-number assignment below.
async function lastCompressedEndIdx(userId: string, threadId: string): Promise<number> {
  const all = await getAllUserSummaries(userId);
  let maxEnd = -1;
  for (const s of all) {
    if (s.value.threadId !== threadId) continue;
    if (s.value.endMessageIndex > maxEnd) maxEnd = s.value.endMessageIndex;
  }
  return maxEnd;
}

// ponytail: window length = largest K-multiple ≤ uncompressedCount
// (round-down). Math: endIdx = uncompressedCount - (uncompressedCount % K) - 1.
// Examples with K=3: uncompressedCount=4 → window [0..2] (3 humans);
// uncompressedCount=7 → window [0..5] (6 humans); uncompressedCount=10 →
// window [0..8] (9 humans).
//
// Why round-down, not "fixed K exactly": a single LLM call covers up to K
// humans of transcript anyway, and the cost scales with input size, not
// count of calls. Round-down means each store write is the maximum
// summarizable window that fits in one prompt — fewer total passes than
// fixed-K (which would write [0..2], then [0..5] on round 9 with no progress
// until lastEnd moves). The "doesn't advance until lastEnd moves" rule
// applies BETWEEN writes, not within a single write.
//
// Gate: uncompressedCount must be ≥ K to fire at all. Below K we return
// null and let the next turn accumulate.
export function computeCumulativeWindow(
  humanCount: number,
  keepRecent: number,
  lastCompressedEndIdx: number,
): { startIdx: number; endIdx: number } | null {
  const firstNew = lastCompressedEndIdx + 1;
  const uncompressedCount = humanCount - firstNew;
  if (uncompressedCount < keepRecent) return null;
  const endIdx = humanCount - (humanCount % keepRecent) - 1;
  return { startIdx: firstNew, endIdx: endIdx };
}

// ponytail: side-effect-only node. Runs the LLM compression, persists
// the SummaryEntry to the store, returns an empty state update. The
// messages channel is intentionally NOT touched: removing original
// turns would erase user-visible history ("where did my messages go?"),
// and injecting a synthetic HumanMessage would render in the chat as
// a phantom user turn ("I didn't say that"). The summary lives in the
// store AND in the chatAgent's `<threads>` system block at invoke
// time (see backend/memory/template.ts) — the model reads it as
// compressed history, the Memory tab displays it, but state.messages
// stays the original turns.
//
// Defensive gates: missing userId / thread_id → empty state update.
// These would have been END'd by the conditional edge, but a tick
// can race — re-deriving here is the safety belt.
export async function threadSummarizeNode(
  state: { messages?: Array<ExcerptMessage> },
  config: Config,
): Promise<{ messages: never[] }> {
  const userId = config.configurable?.userId;
  const threadId = config.configurable?.thread_id;
  if (typeof userId !== "string" || userId.length === 0) return { messages: [] };
  if (typeof threadId !== "string" || threadId.length === 0) return { messages: [] };

  const messages = (state.messages ?? []) as Array<ExcerptMessage>;
  const humanIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (isHumanMessage(m)) humanIndices.push(i);
  }

  // ponytail: cheap necessary-condition check first. The router may
  // have already gated, but a turn can land between router and node —
  // re-deriving here is the safety belt AND avoids a needless store
  // scan when the thread hasn't crossed KEEP_RECENT yet.
  if (humanIndices.length <= MEMORY_THREAD_SUMMARY_KEEP_RECENT) return { messages: [] };

  const lastEnd = await lastCompressedEndIdx(userId, threadId);

  const window = computeCumulativeWindow(
    humanIndices.length,
    MEMORY_THREAD_SUMMARY_KEEP_RECENT,
    lastEnd,
  );

  if (!window) return { messages: [] };
  const { startIdx, endIdx } = window;

  // ponytail: build the excerpt from the closed human-only interval.
  // The slice covers everything between humanIndices[startIdx] and
  // humanIndices[endIdx], inclusive of every interleaved AI/tool reply.
  // Unknown / orphan roles are dropped from the LLM-facing transcript
  // (KEEPABLE_TYPES gate) — the original messages still live in
  // state.messages for the chat UI.
  const sliceStart = humanIndices[startIdx];
  const sliceEnd = humanIndices[endIdx];
  const excerpt: Array<ExcerptMessage> = [];
  for (let i = sliceStart; i <= sliceEnd; i++) {
    const m = messages[i];
    if (!m) continue;
    const t = m.type;
    if (t && KEEPABLE_TYPES.has(t)) excerpt.push(m);
  }

  if (excerpt.length === 0) return { messages: [] };

  // ponytail: messageIds is parallel to the covered-human range so a
  // future tool can rehydrate the original turns by id. AI/tool
  // interleaving is excluded — those messages live on in
  // state.messages and the checkpointer serves them when needed.
  const humanMessageIds = excerpt.filter((m) => isHumanMessage(m)).map((m) => m.id ?? "");

  // ponytail: token counts before/after compression. Recorded in the
  // SummaryEntry for future analytics + UI stats.
  // countTokensApproximately is the same heuristic LangChain's
  // summarizationMiddleware uses for its token-budget gate (4 chars
  // ≈ 1 token). We don't gate on a hard budget — turn-based trigger
  // is primary — but the numbers let a future token-based second
  // pass skip work and let the UI render "compressed 420 → 80 tokens"
  // without a separate re-tokenize call.
  // ponytail: token counts before/after compression. Recorded in the
  // SummaryEntry for future analytics + UI stats — local char-based
  // estimate (~4 chars/token) is good enough for analytics; the
  // trigger itself is turn-count-based, not token-budget-gated.
  const tokenCountBefore = estimateTokensFromExcerpt(excerpt);

  const transcript = renderTranscript(excerpt, startIdx);

  /* oxlint-disable no-unreachable */
  let out: z.infer<typeof summaryOutputSchema>;
  try {
    // ponytail: "nostream" tag so partial tokens don't leak into the
    // chat stream — the summary is a side-effect, not a user-visible
    // reply.
    out = await chatModel
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
  } catch (e) {
    // ponytail: bg agent — failures here MUST NOT throw. A failed
    // pass means one missed trigger point; the next turn re-fires
    // the same window (stateless formula), so the compression
    // eventually lands. Throwing would crash the background agent
    // and leave every later dispatch dead.
    console.warn("[threadSummarizeNode] LLM call failed", {
      userId,
      threadId,
      startIdx,
      endIdx,
      cause: (e as Error).message ?? String(e),
    });
    return { messages: [] };
  }

  // ponytail: an empty `entries` (LLM skipped everything) means there's
  // nothing to persist. Empty state update, no SummaryEntry written.
  if (!out.entries || out.entries.length === 0) return { messages: [] };

  const summaryText = formatSummaryText(out.entries);
  const tokenCountAfter = estimateTokens(summaryText);

  // ponytail: read the latest sequence for this thread to number the
  // next entry. The store read happens AFTER the window check so a
  // short-thread dispatch doesn't pay the cost.
  const uid = userId as string;
  const tid = threadId as string;
  const allSummaries = await getAllUserSummaries(uid);
  const latestSeq = allSummaries
    .filter((s) => s.value.threadId === tid)
    .reduce((max, s) => Math.max(max, s.value.sequence), 0);

  await writeSummary(uid, {
    threadId: tid,
    sequence: latestSeq + 1,
    startMessageIndex: startIdx,
    endMessageIndex: endIdx,
    messageCount: endIdx - startIdx + 1,
    messageIds: humanMessageIds,
    summary: summaryText,
    triggerReason: "turn_based",
    tokenCountBefore,
    tokenCountAfter,
  });

  // ponytail: empty state update — the messages channel is left alone.
  return { messages: [] };
  /* oxlint-enable no-unreachable */
}
