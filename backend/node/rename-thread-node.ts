import { BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { renameThread } from "@/lib/threads/queries";
import { chatModelWithoutThink } from "@/backend/model";

// Generates a short chat title from the first user message. Writes the
// final title once via config.writer() so the sidebar can react in real
// time; persists the title to the threads row. Runs only on the first
// message of a thread — the graph's afterAgent conditional skips this
// node once state.title is set.
//
// `chatModelWithoutThink.invoke()` is used (not `.stream()`): the langgraph
// runtime auto-broadcasts streaming LLM tokens as `messages/partial` events,
// which useLangGraphMessages renders as chat messages. We don't want the
// title text showing up in the thread, so we don't stream.
//
// Receives the full graph state (with `messages`) because the conditional
// edge just routes by node name — there's no input-args mechanism for
// non-Send transitions.
export async function renameThreadNode(
  { messages }: { messages: BaseMessage[] },
  config: { writer?: (chunk: unknown) => void; configurable?: { thread_id?: string } },
) {
  const firstUserMessage = messages.find((m) => m.getType() === "human");
  if (!firstUserMessage) return;

  const response = await chatModelWithoutThink.invoke([
    new SystemMessage(
      "为以下对话生成 3-6 个词的标题,使用对话中使用的语言。直接输出标题,不要前缀、不要引号、不要解释。",
    ),
    firstUserMessage as HumanMessage,
  ]);
  const trimmed = (typeof response.content === "string" ? response.content : "").trim();

  const threadId = config.configurable?.thread_id;

  // write to db, will fetch by adapter generateTitle
  if (threadId) await renameThread(threadId, trimmed);

  return null;
}
