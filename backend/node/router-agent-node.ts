import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";

import { getChatModel } from "@/backend/model";
import { ROUTER_AGENT_PROMPT } from "@/backend/prompt/system";
import { hasUnprocessedFile, stripFileParts } from "@/lib/kb/extract";
import { prepareMessagesForInvoke, loadThreadSummariesForPrompt } from "@/backend/memory/template";
import { extractUserId } from "@/backend/memory/recall";
import { getAgentPrompt } from "@/backend/prompt/loader";
import { matchKeywordRoute } from "@/lib/router/keywords";

// ponytail: v4 tiered router. Two short-circuits and a fallback:
//   1. Rule Short-circuit: ANY HumanMessage has an unprocessed PDF/file → route to kbAgent (source: "rule").
//   2. Keyword Short-circuit: last HumanMessage matches priority keyword rules → route to target agent (source: "keyword").
//   3. LLM Fallback: resolve kb_refs + trim, ask the LLM for structured routing (source: "llm").

const RouteDecisionSchema = z.object({
  next: z.enum(["weatherAgent", "chatAgent", "cryptoAgent", "codeAgent", "kbAgent"]),
  source: z.enum(["rule", "keyword", "llm"]).optional(),
  matchedKey: z.string().optional(),
});

const InvokeRouteDecisionSchema = z
  .object({
    next: z
      .enum(["weatherAgent", "chatAgent", "cryptoAgent", "codeAgent"])
      .describe(
        "The target specialized agent to dispatch execution to, determined by analyzing the user's message intent and requirements.",
      ),
  })
  .describe(
    "Routing decision indicating which downstream specialized agent should handle the user's input",
  );

export type RouterDecision = z.infer<typeof RouteDecisionSchema>;

export async function routerAgentNode(
  state: { messages: BaseMessage[] },
  config?: RunnableConfig,
): Promise<{ routerDecision: RouterDecision }> {
  const lastUserMessage = state.messages.findLast((m) => m instanceof HumanMessage);

  // Tier 1 Short-circuit (Rule): any HumanMessage has an unprocessed file → kbAgent.
  if (hasUnprocessedFile(state.messages)) {
    return { routerDecision: { next: "kbAgent", source: "rule" } };
  }

  // Tier 2 Short-circuit (Keyword): last HumanMessage matches priority keyword rules.
  if (lastUserMessage) {
    const keywordResult = matchKeywordRoute(lastUserMessage);
    if (keywordResult) {
      return {
        routerDecision: {
          next: keywordResult.agent,
          source: "keyword",
          matchedKey: keywordResult.matchedKey,
        },
      };
    }
  }

  const userId = extractUserId(config);

  const promptInfo = await getAgentPrompt("routerAgent", userId ?? undefined);
  const system = new SystemMessage(promptInfo.content);
  const threads = await loadThreadSummariesForPrompt(config);
  const trimmed = await prepareMessagesForInvoke(state.messages, threads?.summaries ?? [], userId ?? undefined, {
    includeToolMessages: false,
  });

  const trimmedClean = trimmed.map(stripFileParts);
  const lastClean = lastUserMessage ? stripFileParts(lastUserMessage) : null;

  const invokeMessages = lastClean
    ? [system, ...trimmedClean.filter((m) => m.id !== lastClean.id), lastClean]
    : [system, ...trimmedClean];

  // Tier 3 LLM Fallback
  const decision = (await (
    await getChatModel()
  )
    .withStructuredOutput(InvokeRouteDecisionSchema, {
      name: "route_decision",
      method: "jsonSchema",
      strict: true,
    })
    .invoke(invokeMessages, {
      ...config,
      tags: [...(config?.tags ?? []), "nostream"],
    })) as RouterDecision;

  return {
    routerDecision: {
      ...decision,
      source: "llm",
    },
  };
}

