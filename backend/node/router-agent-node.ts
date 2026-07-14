import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";

import { getChatModel } from "@/backend/model";
import { ROUTER_AGENT_PROMPT } from "@/backend/prompt/system";
import { extractFilePart, extractKbRef, isPdfAttachment } from "@/lib/kb/extract";
import { trimMessagesForInvoke } from "@/backend/memory/template";
import { extractUserId } from "@/backend/memory/recall";

// ponytail: v2 router (issue #13). Two short-circuits and a fallback:
//   1. PDF file part + no kb_ref in last HumanMessage → route to kbAgent.
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
  const filePart = extractFilePart(state.messages);
  const kbRef = extractKbRef(state.messages);

  // Short-circuit: new PDF (file part but no kb_ref yet) → kbAgent.
  if (filePart && isPdfAttachment(filePart) && !kbRef) {
    return { routerDecision: { next: "kbAgent" } };
  }

  const system = new SystemMessage(ROUTER_AGENT_PROMPT);
  const userId = extractUserId(config);
  const trimmed = await trimMessagesForInvoke(state.messages, [], userId ?? undefined);
  const invokeMessages = lastUserMessage
    ? [system, lastUserMessage, ...trimmed.filter((m) => m.id !== lastUserMessage.id)]
    : [system, ...trimmed];

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
