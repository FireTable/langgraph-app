import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";

import { getChatModel } from "@/backend/model";
import { ROUTER_AGENT_PROMPT } from "@/backend/prompt/system";

// Router agent: inspects the latest user message and decides which
// sub-agent should handle the turn. Output is a zod-validated object
// so the parser never has to handle malformed JSON — the schema is
// the contract.
//
// Method: `functionCalling` with the `nostream` invocation tag. The
// schema is registered as a tool so the model emits a `tool_call` on
// the AIMessage; we discard the AIMessage and return only the parsed
// `routerDecision` to the state. `tags: ["nostream"]` keeps the run's
// token stream free of the router's internal reasoning.
const RouteDecisionSchema = z.object({
  next: z.enum(["weatherAgent", "chatAgent", "cryptoAgent", "codeAgent"]),
});

export type RouterDecision = z.infer<typeof RouteDecisionSchema>;

export async function routerAgentNode(
  state: { messages: BaseMessage[] },
  config?: RunnableConfig,
): Promise<{ routerDecision: RouterDecision }> {
  // ponytail: router is a yes/no classifier on the CURRENT turn. Full
  // history is a token-cost move AND can distract the classifier into
  // routing off a stale topic. The trailing HumanMessage is always the
  // current turn — the router runs before any AI reply for this turn
  // exists.
  const lastUserMessage = state.messages.findLast((m) => m instanceof HumanMessage);
  const system = new SystemMessage(ROUTER_AGENT_PROMPT);
  const invokeMessages = lastUserMessage ? [system, lastUserMessage] : [system];

  const decision = (await (await getChatModel())
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
