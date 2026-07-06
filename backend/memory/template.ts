import { PromptTemplate } from "@langchain/core/prompts";
import { SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { MemoryDoc } from "@/lib/memory/queries";
import type { SummaryEntry } from "@/lib/memory/validators";
import { extractUserId, getCachedMemory, type LoadedMemory } from "@/backend/memory/recall";
import { MEMORY_AUGMENTED_PROMPT_TEMPLATE } from "@/backend/prompt/system";

// ponytail: the system prompt carries TWO dynamic blocks:
//   <memory>    = the user's saved profile (keys + values), plus OAuth
//                 overlay (name / email / image / socials) when set.
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
  // ponytail: threads JSON is the rendered summary text + per-pass
  // bookkeeping (sequence + index range + token counts). Empty when no
  // summary has fired yet for this thread.
  const threadsJson =
    threads && threads.summaries.length > 0
      ? JSON.stringify({ threadId: threads.threadId, summaries: threads.summaries }, null, 2)
      : "";
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
