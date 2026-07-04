// Merge in-flight subgraph messages back into the parent's messages list
// so a paused run (e.g. ask_location waiting on the user's pick) survives a
// page refresh.
//
// Why this exists: parent graph state.values.messages only carries writes
// that have propagated back through the parent's channel reducers. While
// __interrupt__ is open, pregel keeps the parent state frozen
// (algo.js IGNORE set includes INTERRUPT), so the AI message + tool_call
// the subgraph emitted before pausing never land in parent.messages. They
// live on the subgraph's own channel — visible via state.tasks[].state
// when the SDK is asked with { subgraphs: true }.
// SDK's ThreadState.values is typed `DefaultValues` (a generic-free Record),
// so the precise `{ values: { messages: T[] } }` shape isn't visible at the
// helper boundary — callers cast their tasks array once on entry. The
// helper accepts `unknown` for the row and narrows on its own.
type AnySubgraphTask = {
  state?: { values?: { messages?: unknown } } | null;
};

export function mergeSubgraphMessages<T extends { id?: string }>(
  parentMessages: T[],
  tasks: ReadonlyArray<unknown> | undefined,
): T[] {
  // SDK reads interrupts from tasks.at(-1) (see
  // @langchain/langgraph-sdk/src/ui/interrupts.ts: extractInterrupts).
  // Mirror that — the most-recent task is the one still holding the
  // pending subgraph's state.
  let subgraphMessages: T[] | undefined;
  if (tasks && tasks.length > 0) {
    for (let i = tasks.length - 1; i >= 0; i--) {
      const state = (tasks[i] as AnySubgraphTask | undefined)?.state;
      const candidate = state?.values?.messages;
      if (Array.isArray(candidate) && candidate.length > 0) {
        subgraphMessages = candidate as T[];
        break;
      }
    }
  }
  if (!subgraphMessages) return parentMessages;

  const seen = new Set<string>();
  for (const m of parentMessages) {
    if (typeof m?.id === "string") seen.add(m.id);
  }
  const merged = [...parentMessages];
  for (const m of subgraphMessages) {
    if (typeof m?.id === "string") {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
    }
    merged.push(m);
  }
  return merged;
}