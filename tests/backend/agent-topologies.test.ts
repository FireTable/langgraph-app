import { describe, it, expect } from "vitest";

import { buildInlined, buildSubgraph } from "@/backend/agent";

// Smoke test for both graph topologies. The default (inlined) path is
// exercised end-to-end by tests/backend/agent.test.ts; this file only
// asserts the structural shape of both builders so the subgraph path
// stays valid even though it's not the default runtime topology.

describe("buildSubgraph", () => {
  it("registers the compiled subgraphs as opaque nodes", () => {
    const builder = buildSubgraph();
    expect(Object.keys(builder.nodes).sort()).toEqual([
      "afterAgent",
      "chatAgent",
      "codeAgent",
      "cryptoAgent",
      "renameThreadAgent",
      "routerAgent",
      "weatherAgent",
    ]);
  });

  it("compiles without throwing", () => {
    const builder = buildSubgraph();
    expect(() => builder.compile()).not.toThrow();
  });
});

describe("buildInlined", () => {
  it("registers the inlined model/tool nodes (no chatAgent/weatherAgent wrappers)", () => {
    const builder = buildInlined();
    expect(Object.keys(builder.nodes).sort()).toEqual([
      "afterAgent",
      "chatModel",
      "chatTools",
      "codeModel",
      "codeTools",
      "cryptoModel",
      "cryptoTools",
      "renameThreadAgent",
      "routerAgent",
      "weatherModel",
      "weatherTools",
    ]);
  });

  it("compiles without throwing", () => {
    const builder = buildInlined();
    expect(() => builder.compile()).not.toThrow();
  });
});
