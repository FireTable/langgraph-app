import { touchLastMessageAt } from "@/lib/threads/queries";

// Side-effects that should fire after `agent` produces a reply but before
// the run ends. Currently just bumps `threads.last_message_at`; add more
// post-agent work here as it lands (e.g. usage counters, async fan-out).
export async function afterAgentNode(
  _state: unknown,
  config: { configurable?: { thread_id?: string } },
): Promise<void> {
  const threadId = config.configurable?.thread_id;
  if (!threadId) return;
  await touchLastMessageAt(threadId);
}
