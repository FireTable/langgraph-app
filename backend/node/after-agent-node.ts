import { touchLastMessageAt } from "@/lib/threads/queries";

export async function afterAgentNode(
  _state: unknown,
  config: { configurable?: { thread_id?: string } },
): Promise<void> {
  const threadId = config.configurable?.thread_id;
  if (!threadId) return;
  await touchLastMessageAt(threadId);
}
