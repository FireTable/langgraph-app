import "@/tests/helpers/session";
import { describe, expect, it } from "vitest";
import { routeByMode, routeByTargetAgent } from "@/backend/agent/eval-agent";

describe("evalAgent — routeByMode", () => {
  it("returns 'judge' when mode is undefined", () => {
    expect(routeByMode({})).toBe("judge");
  });

  it("returns 'judge' when mode is explicitly 'judge'", () => {
    expect(routeByMode({ mode: "judge" })).toBe("judge");
  });

  it("returns 'benchmark' when mode is 'benchmark'", () => {
    expect(routeByMode({ mode: "benchmark" })).toBe("benchmark");
  });
});

describe("evalAgent — routeByTargetAgent", () => {
  it("returns the matching invocation node name", () => {
    expect(routeByTargetAgent({ targetAgent: "chatAgent" })).toBe("invokeChatAgent");
    expect(routeByTargetAgent({ targetAgent: "weatherAgent" })).toBe("invokeWeatherAgent");
    expect(routeByTargetAgent({ targetAgent: "renameThreadAgent" })).toBe(
      "invokeRenameThreadAgent",
    );
  });

  it("falls back to invokeChatAgent for unknown / missing targetAgent", () => {
    expect(routeByTargetAgent({})).toBe("invokeChatAgent");
    expect(routeByTargetAgent({ targetAgent: "unknownAgent" })).toBe("invokeChatAgent");
  });
});
