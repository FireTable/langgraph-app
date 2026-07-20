import { BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { renameThread } from "@/lib/threads/queries";
import { getChatModel } from "@/backend/model";
import { RENAME_THREAD_PROMPT } from "@/backend/prompt/system";
import { stripFileParts } from "@/lib/kb/extract";

export async function renameThreadAgentNode(
  state: { messages: BaseMessage[] },
  config: { writer?: (chunk: unknown) => void; configurable?: { thread_id?: string } },
): Promise<null | undefined> {
  const firstUserMessage = state.messages.find((m): m is HumanMessage => m instanceof HumanMessage);
  if (!firstUserMessage) return undefined;

  const response = await (
    await getChatModel()
  ).invoke([new SystemMessage(RENAME_THREAD_PROMPT), stripFileParts(firstUserMessage)], {
    tags: ["nostream"],
  });
  const trimmed = (typeof response.content === "string" ? response.content : "").trim();

  const threadId = config.configurable?.thread_id;
  if (threadId && trimmed) await renameThread(threadId, trimmed);

  return null;
}
