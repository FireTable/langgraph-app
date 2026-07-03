import { PromptTemplate } from "@langchain/core/prompts";
import { SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { SummaryEntry } from "@/lib/memory/validators";
import type { MemoryDoc } from "@/lib/memory/queries";
import { extractUserId, getCachedMemory, type LoadedMemory } from "@/backend/memory/recall";
import { MEMORY_AUGMENTED_PROMPT_TEMPLATE } from "@/backend/prompt/system";

// ponytail: the schema for what we inject into every model call. memory
// is the merged user-saved doc + live auth overlay (see mergeMemory in
// recall.ts); threads is the top-K recent summaries the user has
// touched in past sessions.
export type MemoryPayload = LoadedMemory & {
  memory: MemoryDoc;
  threads: Array<{ key: string; value: SummaryEntry }>;
};

const promptTemplate = new PromptTemplate({
  template: MEMORY_AUGMENTED_PROMPT_TEMPLATE,
  templateFormat: "mustache",
  inputVariables: ["base", "memoryJson", "threadsJson"],
});

function isEmptyPayload(p: MemoryPayload): boolean {
  return Object.keys(p.memory).length === 0 && p.threads.length === 0;
}

export async function createSystemPromptWithMemoryTemplate(
  base: string,
  memory: MemoryPayload | null,
): Promise<SystemMessage> {
  const effective = memory && !isEmptyPayload(memory) ? memory : null;
  const memoryJson = effective ? JSON.stringify(effective.memory, null, 2) : "";
  const threadsJson =
    effective && effective.threads.length > 0 ? JSON.stringify(effective.threads, null, 2) : "";
  // ponytail: mustache keeps the `\n\n` after `{{base}}` even when the
  // section is empty, so the no-memory path would render an extra blank
  // line. trimEnd strips it.
  const content = (await promptTemplate.format({ base, memoryJson, threadsJson })).trimEnd();

  return new SystemMessage(content);
}

// ponytail: the public entry point — agent nodes pass the LangGraph
// RunnableConfig and this pulls userId from configurable, fetches
// memory via the LRU-cached recall path, and renders the SystemMessage.
// Without a userId (unauthed dev path) it returns the base prompt
// verbatim.
export async function buildSystemMessageWithMemory(
  basePrompt: string,
  config?: RunnableConfig,
): Promise<SystemMessage> {
  const userId = extractUserId(config);
  if (!userId) return new SystemMessage(basePrompt);
  const loaded = await getCachedMemory(userId);
  return createSystemPromptWithMemoryTemplate(basePrompt, loaded);
}
