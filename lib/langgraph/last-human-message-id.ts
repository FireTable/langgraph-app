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

function getField(o: Record<string, unknown>, field: string): unknown {
  if (field in o && o[field] !== undefined) return o[field];
  if (o.kwargs && typeof o.kwargs === "object" && field in o.kwargs) {
    const v = (o.kwargs as Record<string, unknown>)[field];
    if (v !== undefined) return v;
  }
  if (o.lc_kwargs && typeof o.lc_kwargs === "object" && field in o.lc_kwargs) {
    const v = (o.lc_kwargs as Record<string, unknown>)[field];
    if (v !== undefined) return v;
  }
  return undefined;
}

export function lastHumanMessageId(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;

    if (m instanceof HumanMessage) {
      if (typeof m.id === "string" && m.id.length > 0) return m.id;
    }

    const role =
      getField(m as Record<string, unknown>, "type") ??
      getField(m as Record<string, unknown>, "role");
    if (role === "human" || role === "user") {
      const id = getField(m as Record<string, unknown>, "id");
      if (typeof id === "string" && id.length > 0) return id;
    }
  }
  return null;
}
