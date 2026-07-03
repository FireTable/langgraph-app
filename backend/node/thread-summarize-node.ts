import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";

import {
  MEMORY_THREAD_SUMMARY_KEEP_RECENT,
  MEMORY_THREAD_SUMMARY_THRESHOLD,
} from "@/lib/memory/constants";
import { getAllUserSummaries, writeSummary } from "@/lib/memory/queries";
import { chatModel } from "@/backend/model";
import { THREAD_SUMMARIZE_PROMPT } from "@/backend/prompt/system";

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
//
// Window math is keyed off the user-message count (startIdx/endIdx
// index into the human-only sequence), but the LLM is shown the full
// human+ai transcript slice — summaries need to see the assistant's
// replies to know what the discussion actually resolved.
//
// Routing split: `shouldSummarizeRouter` is the conditional-edge gate
// that runs BEFORE this node (see backend/agent.ts). It returns the
// cheap "is there potentially a window?" answer from the messages
// channel alone — no store read. The store-dependent close-window
// check (endIdx < startIdx, missing userId/thread_id) still lives
// here so the node stays the single source of truth for "is there
// work to do?" once it's been entered.
export async function threadSummarizeNode(
  state: ThreadSummarizeState,
  config: Config,
): Promise<Record<string, never>> {
  const userId = config.configurable?.userId;
  const threadId = config.configurable?.thread_id;
  if (typeof userId !== "string" || userId.length === 0) return {};
  if (typeof threadId !== "string" || threadId.length === 0) return {};

  const humanMessages = (state.messages ?? []).filter((m) => m.type === "human");
  const userMessageCount = humanMessages.length;
  // ponytail: the router only checks the cheap necessary condition
  // (> THRESHOLD + KEEP_RECENT); this catches the rare "prior summary
  // already covered through the endIdx" case where the window is empty.
  if (userMessageCount <= MEMORY_THREAD_SUMMARY_THRESHOLD) return {};

  const allSummaries = await getAllUserSummaries(userId);
  const latest = allSummaries
    .filter((s) => s.value.threadId === threadId)
    .sort((a, b) => b.value.sequence - a.value.sequence)[0];

  const startIdx = (latest?.value.endMessageIndex ?? -1) + 1;
  const endIdx = userMessageCount - MEMORY_THREAD_SUMMARY_KEEP_RECENT;
  if (endIdx < startIdx) return {};

  // ponytail: indices name positions in the human-only sequence, but
  // the model needs the actual turns (user + assistant) to write a
  // meaningful summary. Map startIdx..endIdx back to the corresponding
  // slice in the original messages array, then keep only human/ai
  // turns inside that range.
  const startOffset = humanMessages.slice(0, startIdx).length;
  const endOffset = humanMessages.slice(0, endIdx + 1).length;
  const excerpt = (state.messages ?? [])
    .slice(startOffset, endOffset)
    .filter((m) => m.type === "human" || m.type === "ai");
  if (excerpt.length === 0) return {};

  const schema = z.object({
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(800),
  });

  const transcript = excerpt
    .map((m) => `${m.type === "human" ? "User" : "Assistant"}: ${stringifyContent(m.content)}`)
    .join("\n\n");

  const out = await chatModel
    .withStructuredOutput(schema, { method: "jsonSchema" })
    .invoke([new SystemMessage(THREAD_SUMMARIZE_PROMPT), new HumanMessage(transcript)], {
      tags: ["nostream"],
    });

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

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "object" && part && "text" in part ? String(part.text) : ""))
      .filter(Boolean)
      .join(" ");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}
