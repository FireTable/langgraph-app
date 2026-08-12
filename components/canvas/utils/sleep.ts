// ponytail: minimal sleep helper. The original starter ships this for
// demo / fake node execution (e.g. timing out a prompt). We don't
// execute nodes on the canvas — the agent orchestrates — but the
// PromptNode.execute() still sleeps briefly to simulate the round-trip
// so the UI shows a transition flicker. Cheap; pure stdlib.
export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
