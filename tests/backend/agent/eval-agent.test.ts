import "@/tests/helpers/session";
import { describe, expect, it } from "vitest";
import { routeFromInput } from "@/backend/agent/eval-agent";

describe("evalAgent — routeFromInput", () => {
  it("returns 'judgeByLLM' when mode is undefined (legacy default)", () => {
    expect(routeFromInput({})).toBe("judgeByLLM");
  });

  it("returns 'judgeByLLM' when mode is explicitly 'judge'", () => {
    expect(routeFromInput({ mode: "judge" })).toBe("judgeByLLM");
  });

  it("falls back to invokeChatAgent for benchmark mode without a targetAgent (defensive)", () => {
    expect(routeFromInput({ mode: "benchmark" })).toBe("invokeChatAgent");
  });

  it("maps each benchmark targetAgent to its invoke<X>Agent node", () => {
    expect(routeFromInput({ mode: "benchmark", targetAgent: "chatAgent" })).toBe("invokeChatAgent");
    expect(routeFromInput({ mode: "benchmark", targetAgent: "weatherAgent" })).toBe(
      "invokeWeatherAgent",
    );
    expect(routeFromInput({ mode: "benchmark", targetAgent: "cryptoAgent" })).toBe(
      "invokeCryptoAgent",
    );
    expect(routeFromInput({ mode: "benchmark", targetAgent: "codeAgent" })).toBe("invokeCodeAgent");
    expect(routeFromInput({ mode: "benchmark", targetAgent: "kbAgent" })).toBe("invokeKbAgent");
    expect(routeFromInput({ mode: "benchmark", targetAgent: "renameThreadAgent" })).toBe(
      "invokeRenameThreadAgent",
    );
    expect(routeFromInput({ mode: "benchmark", targetAgent: "threadSummarizeAgent" })).toBe(
      "invokeThreadSummarizeAgent",
    );
  });

  it("falls back to invokeChatAgent for unknown targetAgent (defensive)", () => {
    expect(routeFromInput({ mode: "benchmark", targetAgent: "nonsenseAgent" })).toBe(
      "invokeChatAgent",
    );
    expect(routeFromInput({ mode: "benchmark", targetAgent: undefined })).toBe("invokeChatAgent");
  });
});
