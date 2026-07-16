import { z } from "zod";
import { StateSchema, MessagesValue } from "@langchain/langgraph";

// ponytail: userMessageCount is *not* on RouterAgentState because
// deriving it from state.messages in the summarize node (one filter
// over a list of a few hundred messages) is cheaper than threading
// a counter through every model node return. Cost is at most O(N)
// once per N user-message thresholds — well below the rate the chat
// hits `afterAgent`.
//
// ponytail: kb_refs is a sidecar map populated by kbAgent. Keys are
// the file-part URL (`FilePart.data`) carried in the user's HumanMessage,
// values are the ingested kb_document id. The front-end reads this
// map to decorate rendered file tiles with a KB-doc deep link —
// @assistant-ui/react-langgraph's contentToParts filters standalone
// kb_ref parts to null, so a sibling on the file part wouldn't survive
// either (the SDK's `file` switch drops everything except
// type/filename/data/mimeType). Routing through state means the data
// travels on the same `getState` call the chat already makes to load
// messages.
export const RouterAgentState = new StateSchema({
  messages: MessagesValue,
  routerDecision: z.object({
    next: z.enum(["weatherAgent", "chatAgent", "cryptoAgent", "codeAgent", "kbAgent"]),
  }),
  kb_refs: z
    .record(
      z.string(),
      z.object({
        docId: z.string(),
        attachmentId: z.string().optional(),
      }),
    )
    .default({}),
});

export const CommonAgentState = new StateSchema({
  messages: MessagesValue,
});
