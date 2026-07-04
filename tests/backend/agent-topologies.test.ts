import { describe, it, expect } from "vitest";

import { buildSubgraph } from "@/backend/agent";

// Smoke test for the parent graph topology. The default runtime is
// the subgraph path; tests/backend/agent.test.ts exercises it
// end-to-end. This file only asserts the structural shape so the
// compiled subgraphs stay wired correctly.

describe("buildSubgraph", () => {
  it("registers the compiled subgraphs as opaque nodes", () => {
    const builder = buildSubgraph();
    // ponytail: afterAgent + threadSummarize moved to a separate
    // `background_agent` graph in langgraph.json — chat graph now
    // only schedules it via `scheduleBackground`. fan-out is no
    // longer needed (the SDK call inside the node is the side-effect).
    expect(Object.keys(builder.nodes).sort()).toEqual([
      "chatAgent",
      "codeAgent",
      "cryptoAgent",
      "renameThreadAgent",
      "routerAgent",
      "scheduleBackground",
      "weatherAgent",
    ]);
  });

  it("compiles without throwing", () => {
    const builder = buildSubgraph();
    expect(() => builder.compile()).not.toThrow();
  });
});
