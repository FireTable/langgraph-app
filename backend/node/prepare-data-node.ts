import type { RunnableConfig } from "@langchain/core/runnables";
import type { BaseMessage } from "@langchain/core/messages";

import { extractUserId } from "@/backend/memory/recall";
import { resolveKbMentions } from "@/lib/kb/resolve-mentions";

// ponytail: per-turn data-prep node. Runs once at the start of every
// main-graph invocation, BEFORE the router picks a sub-agent. The
// router itself no longer touches message content for KB data — it just
// inspects message SHAPE (PDFs → kbAgent via hasUnprocessedPdf, tool
// calls → resume). All KB @-mention → ToolMessage injection happens
// here, so:
//   1. Every sub-agent (chat / code / weather / crypto / background)
//      sees the same data without re-running the resolver.
//   2. The router doesn't accidentally read the literal `:kb-doc[…]`
//      text (we're not stripping — but router doesn't read messages
//      for content anyway, only for shape).
//   3. Each sub-agent's prepareMessagesForInvoke still strips
//      SystemMessage and trims by summaries; the ToolMessage we
//      inject here survives the SystemMessage filter and lands in
//      the LLM's prompt.
//
// Why a node, not a hook inside chatModel: the resolver hits the DB
// for chunks. Hoisting to a single per-turn node keeps the chat agent
// tool-loop iteration count low (one DB round-trip per turn, not per
// LLM invoke).
//
// kbAgent's router-loop edge (`kbAgent → routerAgent`) bypasses this
// node by design — we don't want to re-inject after kbAgent has
// stamped `kb_ref` onto the PDF.
export async function prepareDataNode(
  state: { messages: BaseMessage[] },
  config?: RunnableConfig,
): Promise<{ messages: BaseMessage[] }> {
  const userId = extractUserId(config) ?? undefined;
  const messages = await resolveKbMentions(state.messages, userId);
  return { messages };
}
