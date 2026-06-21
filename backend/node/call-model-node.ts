import type { BaseMessage } from "@langchain/core/messages";
import { chatModel } from "@/backend/model";

// Calls the chat model with the current message history and returns the
// assistant reply as a MessagesAnnotation-shaped update.
export async function callModelNode({ messages }: { messages: BaseMessage[] }) {
  const response = await chatModel.invoke(messages);
  return { messages: [response] };
}
