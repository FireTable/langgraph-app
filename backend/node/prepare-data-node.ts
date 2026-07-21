import type { RunnableConfig } from "@langchain/core/runnables";
import type { BaseMessage } from "@langchain/core/messages";

// ponytail: per-turn data-prep node. Currently a pass-through — no
// pre-LLM transformation happens here. The KB @-mention flow is
// driven entirely by the LLM reading the directive token
// (':kb-document[label]{documentId=…}' / ':kb-folder[label]{folderId=…}')
// from the HumanMessage text and calling search_kb / list_documents
// with the right filter.
//
// The node is reserved for future per-turn Message transforms:
// stripping tool_call_id duplicates, hydrating attachments, or
// compressing long history. Right now there's nothing to do, so
// messages pass through unchanged. The node still exists because (a)
// the router reads message SHAPE (PDFs → kbAgent via hasUnprocessedFile,
// tool calls → resume) and downstream prepareMessagesForInvoke expects
// a `messages` field on the returned partial state, and (b) the
// router-loop edge (kbAgent → routerAgent) bypasses this node by
// design — we don't want to re-inject after kbAgent has stamped
// `kb_ref` onto the PDF.
export async function prepareDataNode(
  state: { messages: BaseMessage[] },
  _config?: RunnableConfig,
): Promise<{ messages: BaseMessage[] }> {
  return { messages: state.messages };
}
