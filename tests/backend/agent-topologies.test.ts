import { describe, it, expect } from "vitest";

import { builder } from "@/backend/agent";

// Smoke test for the parent graph builder. End-to-end coverage lives
// in tests/backend/agent.test.ts; this file only asserts the
// structural shape so the compiled subgraphs stay wired correctly.

describe("parent graph builder", () => {
  it("registers the compiled subgraphs as opaque nodes", () => {
    // ponytail: afterAgent + threadSummarize moved to a separate
    // `background_agent` graph in langgraph.json — chat graph now
    // only schedules it via `triggerBackgroundAgentNode`. fan-out is no
    // longer needed (the SDK call inside the node is the side-effect).
    expect(Object.keys(builder.nodes).sort()).toEqual([
      "chatAgent",
      "codeAgent",
      "cryptoAgent",
      "renameThreadAgent",
      "routerAgent",
      "triggerBackgroundAgentNode",
      "weatherAgent",
    ]);
  });

  it("compiles without throwing", () => {
    expect(() => builder.compile()).not.toThrow();
  });
});
