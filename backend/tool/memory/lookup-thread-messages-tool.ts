import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { extractUserId, extractThreadId } from "@/backend/memory/recall";
import { checkpointer } from "@/backend/checkpointer";
import { getThreadSummaries } from "@/lib/memory/queries";

export const lookupThreadMessagesInputSchema = z.object({
  refs: z
    .union([
      z.string().describe("Single turn ref label or range (e.g. '#3' or '#3-#5')"),
      z.array(z.string()).describe("Array of turn ref labels (e.g. ['#3', '#4'])"),
    ])
    .describe("Reference labels seen in the <earlier_conversation> system prompt block"),
  includeToolMessages: z
    .boolean()
    .default(false)
    .describe("Whether to include raw tool call and execution output payloads. Defaults to false."),
});

export type LookupThreadMessagesInput = z.infer<typeof lookupThreadMessagesInputSchema>;

/**
 * Parses raw ref input (strings, arrays, ranges like '#3', '3', '#3-#5', ['#3', '#4'])
 * into a set of normalized integer turn numbers (1-indexed).
 */
function parseRequestedTurnNumbers(rawRefs: string | string[]): Set<number> {
  const result = new Set<number>();
  const items = Array.isArray(rawRefs) ? rawRefs : [rawRefs];

  for (const item of items) {
    if (!item) continue;
    const parts = item.split(",").map((s) => s.trim());
    for (const part of parts) {
      if (part.includes("-")) {
        const rangeParts = part.split("-").map((s) => s.replace(/^#/, "").trim());
        const start = parseInt(rangeParts[0] ?? "", 10);
        const end = parseInt(rangeParts[1] ?? "", 10);
        if (!isNaN(start) && !isNaN(end)) {
          for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
            result.add(i);
          }
        }
      } else {
        const num = parseInt(part.replace(/^#/, "").trim(), 10);
        if (!isNaN(num)) {
          result.add(num);
        }
      }
    }
  }

  return result;
}

function stringifyMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  return JSON.stringify(content);
}

export const lookupThreadMessagesTool = tool(
  async (input: LookupThreadMessagesInput, config) => {
    const userId = extractUserId(config);
    const threadId = extractThreadId(config);

    if (!userId || !threadId) {
      return JSON.stringify({
        ok: false,
        error: "Missing userId or threadId in runnable configuration.",
      });
    }

    const requestedTurns = parseRequestedTurnNumbers(input.refs);
    if (requestedTurns.size === 0) {
      return JSON.stringify({
        ok: false,
        error: "Invalid ref format. Please provide turn numbers such as '#3' or '#3-#5'.",
      });
    }

    // 1. Try reading raw state.messages from checkpointer for true rehydration
    let rawMessages: BaseMessage[] = [];
    try {
      if (checkpointer) {
        const tuple = await checkpointer.getTuple({
          configurable: { thread_id: threadId },
        });
        const msgs = tuple?.checkpoint?.channel_values?.messages;
        if (Array.isArray(msgs)) {
          rawMessages = msgs as BaseMessage[];
        }
      }
    } catch {
      // Fallback below if checkpointer is unavailable
    }

    const rehydratedTurns: Array<{
      ref: string;
      messages: Array<{
        role: string;
        content: string;
        toolCalls?: unknown;
      }>;
    }> = [];

    if (rawMessages.length > 0) {
      const humanIndices: number[] = [];
      for (let i = 0; i < rawMessages.length; i++) {
        const m = rawMessages[i];
        if (m instanceof HumanMessage || (m as { type?: string })?.type === "human") {
          humanIndices.push(i);
        }
      }

      for (const turnNum of Array.from(requestedTurns).sort((a, b) => a - b)) {
        const humanIdx = turnNum - 1; // 1-indexed turn to 0-indexed human array
        if (humanIdx < 0 || humanIdx >= humanIndices.length) continue;

        const startPos = humanIndices[humanIdx];
        const endPos =
          humanIdx + 1 < humanIndices.length ? humanIndices[humanIdx + 1] : rawMessages.length;

        const turnSlice = rawMessages.slice(startPos, endPos);
        const formattedMsgs: Array<{ role: string; content: string; toolCalls?: unknown }> = [];

        for (const m of turnSlice) {
          const type = (m as { type?: string }).type;
          const isTool = m instanceof ToolMessage || type === "tool" || type === "function";
          const isAI = m instanceof AIMessage || type === "ai" || type === "assistant";
          const aiMsg = m as AIMessage;
          const hasToolCalls = Array.isArray(aiMsg.tool_calls) && aiMsg.tool_calls.length > 0;
          const contentStr = stringifyMessageContent(m.content);

          if (!input.includeToolMessages) {
            if (isTool) continue;
            if (isAI && hasToolCalls) {
              if (!contentStr.trim()) continue;
              formattedMsgs.push({
                role: type ?? "assistant",
                content: contentStr,
              });
              continue;
            }
          }

          formattedMsgs.push({
            role: type ?? "unknown",
            content: contentStr,
            ...(hasToolCalls && input.includeToolMessages ? { toolCalls: aiMsg.tool_calls } : {}),
          });
        }

        rehydratedTurns.push({
          ref: `#${turnNum}`,
          messages: formattedMsgs,
        });
      }
    }

    // Fallback: If checkpointer raw messages were unavailable, query SummaryEntry
    if (rehydratedTurns.length === 0) {
      const summaries = await getThreadSummaries(userId, threadId);
      if (summaries && summaries.length > 0) {
        for (const summaryEntry of summaries) {
          for (const entry of summaryEntry.summary.entries) {
            const entryTurnSet = parseRequestedTurnNumbers(entry.refs);
            const isMatch = Array.from(requestedTurns).some((t) => entryTurnSet.has(t));
            if (isMatch) {
              const refsLabel = entry.refs.map((r) => (r.startsWith("#") ? r : `#${r}`)).join(", ");
              rehydratedTurns.push({
                ref: refsLabel,
                messages: [
                  { role: "user", content: entry.question },
                  { role: "assistant", content: entry.answer },
                ],
              });
            }
          }
        }
      }
    }

    if (rehydratedTurns.length === 0) {
      return JSON.stringify({
        ok: false,
        error: `Requested ref '${JSON.stringify(input.refs)}' not found in history messages.`,
      });
    }

    return JSON.stringify({
      ok: true,
      queryRefs: input.refs,
      matchCount: rehydratedTurns.length,
      turns: rehydratedTurns,
    });
  },
  {
    name: "lookup_thread_messages",
    description:
      "Rehydrates TRUE UNCOMPRESSED original raw messages (HumanMessage, AIMessage, ToolMessage) from historical turn reference tags (#N) seen in <earlier_conversation>.",
    schema: lookupThreadMessagesInputSchema,
  },
);
