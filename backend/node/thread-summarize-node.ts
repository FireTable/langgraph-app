import { z } from "zod";

import {
  MEMORY_THREAD_SUMMARY_KEEP_RECENT,
  MEMORY_THREAD_SUMMARY_THRESHOLD,
} from "@/lib/memory/constants";
import { getAllUserSummaries, writeSummary } from "@/lib/memory/queries";
import { chatModel } from "@/backend/model";

type ThreadSummarizeState = {
  messages?: Array<{ type?: string; content?: unknown }>;
  // ponytail: optional convenience field — tests construct fixtures that
  // include the derived user-message count alongside messages so the
  // expected endMessageIndex reads naturally. The node derives it itself
  // from `messages` and ignores this field if present.
  userMessageCount?: number;
};

type Config = { configurable?: { userId?: unknown; thread_id?: unknown } };

// ponytail: FR-009..012 — closed interval [startIdx, endIdx]; JS slice
// uses endIdx+1 to materialize the inclusive range. The skip condition
// is `endIdx < startIdx` (window is zero messages); 1-message and
// 2-message windows are valid (FR-010 edge cases).
export async function threadSummarizeNode(
  state: ThreadSummarizeState,
  config: Config,
): Promise<Record<string, never>> {
  const userId = config.configurable?.userId;
  const threadId = config.configurable?.thread_id;
  if (typeof userId !== "string" || userId.length === 0) return {};
  if (typeof threadId !== "string" || threadId.length === 0) return {};

  const allMessages = (state.messages ?? []).filter((m) => m.type === "human" || m.type === "ai");
  const userMessageCount = allMessages.filter((m) => m.type === "human").length;
  if (userMessageCount <= MEMORY_THREAD_SUMMARY_THRESHOLD) return {};

  const allSummaries = await getAllUserSummaries(userId);
  const latest = allSummaries
    .filter((s) => s.value.threadId === threadId)
    .sort((a, b) => b.value.sequence - a.value.sequence)[0];

  const startIdx = (latest?.value.endMessageIndex ?? -1) + 1;
  const endIdx = userMessageCount - MEMORY_THREAD_SUMMARY_KEEP_RECENT;
  if (endIdx < startIdx) return {};

  const window = allMessages.slice(startIdx, endIdx + 1);
  if (window.length === 0) return {};

  const prompt = `Summarize the following conversation excerpt. Reply with JSON: {"name": "≤80-char title", "description": "≤500-char summary"}.\n\n${JSON.stringify(window)}`;
  const schema = z.object({
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(800),
  });

  const out = (await chatModel
    .withStructuredOutput(schema, { method: "jsonSchema" })
    .invoke(prompt)) as { name: string; description: string };

  await writeSummary(userId, {
    threadId,
    sequence: (latest?.value.sequence ?? 0) + 1,
    name: out.name,
    description: out.description,
    startMessageIndex: startIdx,
    endMessageIndex: endIdx,
    messageCount: endIdx - startIdx + 1,
  });

  return {};
}
