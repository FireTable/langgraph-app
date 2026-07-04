import { PromptTemplate } from "@langchain/core/prompts";
import { SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { MemoryDoc } from "@/lib/memory/queries";
import { extractUserId, getCachedMemory, type LoadedMemory } from "@/backend/memory/recall";
import { MEMORY_AUGMENTED_PROMPT_TEMPLATE } from "@/backend/prompt/system";

// ponytail: the system prompt is now memory-only — the cross-thread
// threadsJson block was removed (see MEMORY_AUGMENTED_PROMPT_TEMPLATE).
// Thread summaries live inline in the messages channel for the current
// thread (see threadSummarizeNode), so the model reads them in
// conversation order instead of as an out-of-band "previous chats"
// block that mixed contexts across threads.
export type MemoryPayload = Pick<LoadedMemory, "memory"> & { memory: MemoryDoc };

const promptTemplate = new PromptTemplate({
  template: MEMORY_AUGMENTED_PROMPT_TEMPLATE,
  templateFormat: "mustache",
  inputVariables: ["base", "memoryJson"],
});

export async function createSystemPromptWithMemoryTemplate(
  base: string,
  memory: MemoryPayload | null,
): Promise<SystemMessage> {
  const effective = memory && Object.keys(memory.memory).length > 0 ? memory : null;
  const memoryJson = effective ? JSON.stringify(effective.memory, null, 2) : "";
  // ponytail: mustache keeps the `\n\n` after `{{base}}` even when the
  // section is empty, so the no-memory path would render an extra blank
  // line. trimEnd strips it.
  const content = (await promptTemplate.format({ base, memoryJson })).trimEnd();

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
  if (!loaded) return new SystemMessage(basePrompt);
  return createSystemPromptWithMemoryTemplate(basePrompt, { memory: loaded.memory });
}
