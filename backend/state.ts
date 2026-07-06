import { z } from "zod";
import { StateSchema, MessagesValue } from "@langchain/langgraph";

// ponytail: userMessageCount is *not* on RouterAgentState because
// deriving it from state.messages in the summarize node (one filter
// over a list of a few hundred messages) is cheaper than threading
// a counter through every model node return. Cost is at most O(N)
// once per N user-message thresholds — well below the rate the chat
// hits `afterAgent`.
export const RouterAgentState = new StateSchema({
  messages: MessagesValue,
  routerDecision: z.object({
    next: z.enum(["weatherAgent", "chatAgent", "cryptoAgent", "codeAgent"]),
  }),
});

export const CommonAgentState = new StateSchema({
  messages: MessagesValue,
});
