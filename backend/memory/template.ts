import { PromptTemplate } from "@langchain/core/prompts";
import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { getThreadSummaries, type MemoryDoc } from "@/lib/memory/queries";
import type { SummaryEntry } from "@/lib/memory/validators";
import {
  extractThreadId,
  extractUserId,
  getCachedMemory,
  type LoadedMemory,
} from "@/backend/memory/recall";
import { MEMORY_AUGMENTED_PROMPT_TEMPLATE } from "@/backend/prompt/system";
import { formatSummaryText } from "@/lib/langgraph/format-summary";
import { resolveKbRefs } from "@/lib/kb/resolve";

// ponytail: the system prompt carries TWO dynamic blocks:
//   <memory>    = the user's saved profile (keys + values), plus OAuth
//                 overlay (name / email / avatar / socials) when set.
//   <threads>   = compressed Q&A history for THIS thread, pulled from
//                 the store at invoke time. Mounts the historical
//                 content the model would otherwise lose when older
//                 turns fall off the chat UI. The chatAgent re-reads
//                 the store on every invoke — threadSummarizeNode
//                 writes to the store but never touches
//                 state.messages, so summaries only surface here.
//
// Both blocks are conditional (`{{#var}}…{{/var}}`) so a user with no
// profile + no summaries gets just the base prompt, no empty
// scaffolding.
export type MemoryPayload = Pick<LoadedMemory, "memory"> & { memory: MemoryDoc };

export type ThreadSummariesPayload = {
  threadId: string;
  summaries: Array<
    Pick<
      SummaryEntry,
      | "sequence"
      | "summary"
      | "startMessageIndex"
      | "endMessageIndex"
      | "triggerReason"
      | "tokenCountBefore"
      | "tokenCountAfter"
      | "createdAt"
    >
  >;
};

const promptTemplate = new PromptTemplate({
  template: MEMORY_AUGMENTED_PROMPT_TEMPLATE,
  templateFormat: "mustache",
  inputVariables: ["base", "memoryJson", "threadsJson"],
});

export async function createSystemPromptWithMemoryTemplate(
  base: string,
  memory: MemoryPayload | null,
  threads: ThreadSummariesPayload | null,
): Promise<SystemMessage> {
  const effective = memory && Object.keys(memory.memory).length > 0 ? memory : null;
  const memoryJson = effective ? JSON.stringify(effective.memory, null, 2) : "";
  // ponytail: the <threads> block mirrors the Memory tab UI — same
  // Q&A text per summary, joined with `---` so the LLM can tell the
  // boundaries between consecutive summary passes. The raw-JSON dump
  // the prior implementation shipped made the model grep for `"answer"`
  // keys instead of just reading the prose. Empty when no summary has
  // fired yet for this thread — the mustache `{{#threadsJson}}...{{/}}`
  // gate collapses the whole block in that case.
  const threadsJson =
    threads && threads.summaries.length > 0 ? formatThreadsForPrompt(threads) : "";
  // ponytail: mustache keeps the `\n\n` after `{{base}}` even when the
  // section is empty, so the no-memory path would render an extra blank
  // line. trimEnd strips it.
  const content = (
    await promptTemplate.format({
      base,
      memoryJson,
      threadsJson,
    })
  ).trimEnd();

  return new SystemMessage(content);
}

// ponytail: per-summary Q&A prose. Across summaries we just join with a
// blank line — the per-entry `#N` ref already anchors each Q&A to its
// turn, so a `---` separator (or any other rule) is noise. Pure
// function — `template.test.ts` pins the exact output so a formatter
// drift doesn't silently change what the model sees vs what the user
// sees in the Memory tab.
export function formatThreadsForPrompt(threads: ThreadSummariesPayload): string {
  return threads.summaries.map((s) => formatSummaryText(s.summary.entries)).join("\n\n");
}

// ponytail: the messages array bound to chatModel.invoke at the model
// node. Does TWO things in one pass:
//   1. drops SystemMessage instances (the bindTools runner leaks them
//      across invokes — strip every call, defensively).
//   2. drops everything covered by the thread's summaries, keeping
//      only the trailing slice from the next human past maxEndIndex.
//
// The model reads the older turns via the <earlier_conversation> block
// in its SystemMessage, so cutting them out of the input array is a
// token-cost move (not a context-loss one). state.messages is NEVER
// touched — UI + checkpointer read from it directly.
//
// Pure function — `template.test.ts` pins every branch (no summary,
// no humans, single summary, multiple summaries, last human covered,
// out-of-order store rows, tool interleaving preserved).
//
// v2 (issue #13): kb_ref resolution happens here too — the LLM only
// ever sees resolved text. Async because resolveKbRefs awaits the
// LRU-cached DB lookup.
export async function trimMessagesForInvoke(
  messages: BaseMessage[],
  summaries: ThreadSummariesPayload["summaries"],
  userId?: string,
): Promise<BaseMessage[]> {
  const resolved = userId ? await resolveKbRefs(messages, userId) : messages;
  const noSystem = resolved.filter((m) => !(m instanceof SystemMessage));
  const humanIndices: number[] = [];
  for (let i = 0; i < noSystem.length; i++) {
    if (noSystem[i] instanceof HumanMessage) humanIndices.push(i);
  }
  let maxEnd = -1;
  for (const s of summaries) {
    if (s.endMessageIndex > maxEnd) maxEnd = s.endMessageIndex;
  }
  // ponytail: no summary OR no human turns in the array → nothing to
  // trim. Returning noSystem (not messages) still drops a stray
  // SystemMessage if one slipped in — the strip pass is unconditional.
  if (maxEnd < 0 || humanIndices.length === 0) return noSystem;
  const trimTo = maxEnd + 1 < humanIndices.length ? humanIndices[maxEnd + 1] : noSystem.length;
  return noSystem.slice(trimTo);
}

// ponytail: the public entry point — agent nodes pass the LangGraph
// RunnableConfig and this pulls userId + threadId from configurable,
// fetches memory + thread summaries via the LRU-cached recall path, and
// renders the SystemMessage. Without a userId (unauthed dev path) it
// returns the base prompt verbatim.
export async function buildSystemMessageWithMemory(
  basePrompt: string,
  config?: RunnableConfig,
  threads?: ThreadSummariesPayload | null,
): Promise<SystemMessage> {
  const userId = extractUserId(config);
  if (!userId) return new SystemMessage(basePrompt);
  const loaded = await getCachedMemory(userId);
  if (!loaded) return new SystemMessage(basePrompt);
  return createSystemPromptWithMemoryTemplate(
    basePrompt,
    { memory: loaded.memory },
    threads ?? null,
  );
}

// ponytail: shared store-read used by every agent's modelNode
// (chatAgent + weatherAgent + cryptoAgent + codeAgent). Reads
// threadSummarizeNode's compressed history for the current thread
// and shapes it into ThreadSummariesPayload (sorted by sequence, with
// only the LLM-relevant fields). Failures are swallowed (null
// payload) — a degraded prompt that loses compressed history is
// better than a chat that 500s on store flake.
//
// Without a userId or threadId in the config (unauthed dev path)
// we also return null — there's no thread to look up.
export async function loadThreadSummariesForPrompt(
  config?: RunnableConfig,
): Promise<ThreadSummariesPayload | null> {
  const userId = extractUserId(config);
  const threadId = extractThreadId(config);
  if (!userId || !threadId) return null;
  try {
    const all = await getThreadSummaries(userId, threadId);
    if (all.length === 0) return null;
    return {
      threadId,
      summaries: all
        .sort((a: { sequence: number }, b: { sequence: number }) => a.sequence - b.sequence)
        .map(
          (s: {
            sequence: number;
            summary: { entries: Array<{ question: string; answer: string; refs: string[] }> };
            startMessageIndex: number;
            endMessageIndex: number;
            triggerReason: "turn_based" | "token_based";
            tokenCountBefore: number;
            tokenCountAfter: number;
            createdAt: string;
          }) => ({
            sequence: s.sequence,
            summary: s.summary,
            startMessageIndex: s.startMessageIndex,
            endMessageIndex: s.endMessageIndex,
            triggerReason: s.triggerReason,
            tokenCountBefore: s.tokenCountBefore,
            tokenCountAfter: s.tokenCountAfter,
            createdAt: s.createdAt,
          }),
        ),
    };
  } catch {
    return null;
  }
}
