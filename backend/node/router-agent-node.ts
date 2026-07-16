import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";

import { getChatModel } from "@/backend/model";
import { ROUTER_AGENT_PROMPT } from "@/backend/prompt/system";
import { hasUnprocessedPdf } from "@/lib/kb/extract";
import { trimMessagesForInvoke } from "@/backend/memory/template";
import { extractUserId } from "@/backend/memory/recall";

// ponytail: v3 router. Two short-circuits and a fallback:
//   1. ANY HumanMessage has an unprocessed PDF → route to kbAgent.
//   2. Otherwise → resolve kb_refs + trim, ask the LLM.
//
// RouterNode is intentionally DB-free: kbAgent owns the contentHash
// dedup probe. The router only inspects message shape.

const RouteDecisionSchema = z.object({
  next: z.enum(["weatherAgent", "chatAgent", "cryptoAgent", "codeAgent", "kbAgent"]),
});

export type RouterDecision = z.infer<typeof RouteDecisionSchema>;

export async function routerAgentNode(
  state: { messages: BaseMessage[] },
  config?: RunnableConfig,
): Promise<{ routerDecision: RouterDecision }> {
  const lastUserMessage = state.messages.findLast((m) => m instanceof HumanMessage);

  // Short-circuit: any HumanMessage has an unprocessed PDF → kbAgent.
  // kbAgent now processes every PDF across every HumanMessage in one
  // invocation, so the router only needs to know "is there still
  // work to do?" — not which turn owns it.
  if (hasUnprocessedPdf(state.messages)) {
    return { routerDecision: { next: "kbAgent" } };
  }

  const system = new SystemMessage(ROUTER_AGENT_PROMPT);
  const userId = extractUserId(config);
  const trimmed = await trimMessagesForInvoke(state.messages, [], userId ?? undefined);

  // ponytail: strip file content parts before sending to the LLM —
  // apimart's Azure Responses API rejects image_url/file content with
  // non-base64 data ("Invalid file data" 400). The model has already
  // routed to kbAgent (kb_ref sibling on every PDF file part) or it's
  // not a PDF — either way the file part is irrelevant for routing.
  function stripFileParts(msg: BaseMessage): BaseMessage {
    if (!Array.isArray(msg.content)) return msg;
    const cleaned = msg.content.filter(
      (p) => typeof p === "object" && p !== null && (p as { type?: string }).type !== "file",
    );
    if (cleaned.length === msg.content.length) return msg;
    return new HumanMessage({ content: cleaned as never, id: msg.id });
  }
  const trimmedClean = trimmed.map(stripFileParts);
  const lastClean = lastUserMessage ? stripFileParts(lastUserMessage) : null;

  const invokeMessages = lastClean
    ? [system, lastClean, ...trimmedClean.filter((m) => m.id !== lastClean.id)]
    : [system, ...trimmedClean];

  // LLM route — schema now includes kbAgent for completeness, but
  // the explicit short-circuit above means we never reach this with a
  // new PDF.
  const decision = (await (
    await getChatModel()
  )
    .withStructuredOutput(RouteDecisionSchema, {
      name: "route_decision",
      method: "jsonSchema",
    })
    .invoke(invokeMessages, {
      ...config,
      tags: [...(config?.tags ?? []), "nostream"],
    })) as RouterDecision;

  return { routerDecision: decision };
}
