// ponytail: walk a LangGraph messages array backwards and return the id
// of the last HumanMessage. Used in two places:
//   - CapturingHandler.handleChainStart: stamps meta.parent_message_id
//     on every span of the current invoke.
//   - triggerBackgroundAgentNode: stamps metadata.parent_message_id on
//     the bg runs.create payload so langGraphClient.runs.list() can
//     scope in-flight bg runs to the current turn.
//
// LangChain's idiomatic filter is `instanceof HumanMessage` — every
// other shape (V1/V2 envelopes, plain {type:'human',...} dicts) is a
// serialization artifact and gets normalized by the reducer before
// reaching us. Envelopes that slip through (e.g. handleChainStart
// firing before the reducer ran) lose their parent_message_id here,
// but bulkInsertSpans backfills from the DB column before INSERT,
// so spans still tag correctly via the eventual HumanMessage row.
import { HumanMessage } from "@langchain/core/messages";

export function lastHumanMessageId(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m instanceof HumanMessage || m.type === "human") {
      const id = m.id;
      return typeof id === "string" && id.length > 0 ? id : null;
    }
  }
  return null;
}
