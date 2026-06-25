import { SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { z } from "zod";

import { chatModel } from "@/backend/model";
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
  next: z.enum(["weatherAgent", "chatAgent"]),
});

export type RouterDecision = z.infer<typeof RouteDecisionSchema>;

export async function routerAgentNode({
  messages,
}: {
  messages: BaseMessage[];
}): Promise<{ routerDecision: RouterDecision }> {
  const system = new SystemMessage(ROUTER_AGENT_PROMPT);
  const history = messages.filter((m) => !(m instanceof SystemMessage));

  const decision = (await chatModel.withStructuredOutput(RouteDecisionSchema, {
    name: "route_decision",
    method: "jsonSchema",
  }).invoke([system, ...history], {
    tags: ["nostream"],
  })) as RouterDecision;

  return { routerDecision: decision };
}
