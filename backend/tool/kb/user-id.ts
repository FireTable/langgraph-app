// ponytail: userId is set per-turn by chat-agent.chatModelNode
// (chat-agent.ts: `setKbToolUserId(userId)` before the model is
// invoked). The LangGraph `ToolNode` runs in a separate node; threading
// the userId across that hop cleanly requires reading RunnableConfig
// (which the `tool()` factory's typed signature drops). Module-local
// capture is the simplest path that works with the existing bindTools +
// ToolNode pattern. Cleared on every chat-agent invocation, set fresh,
// then the tool fires within that same execution.

let currentUserId = "";

export function setKbToolUserId(userId: string): void {
  currentUserId = userId;
}

export function thisUserId(): string {
  if (!currentUserId) {
    throw new Error(
      "KB tool: userId not set — caller must invoke setKbToolUserId() before the tool runs",
    );
  }
  return currentUserId;
}
