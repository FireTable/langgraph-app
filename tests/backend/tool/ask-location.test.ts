import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@langchain/langgraph", async () => {
  const actual = await vi.importActual<typeof import("@langchain/langgraph")>("@langchain/langgraph");
  return {
    ...actual,
    interrupt: vi.fn(),
  };
});

import { askLocationTool } from "@/backend/tool/ask-location";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("askLocationTool", () => {
  it("returns the awaiting-location sentinel synchronously", async () => {
    const result = await askLocationTool.invoke({});
    // ToolNode wraps every result as a string, so the tool body
    // returns the sentinel pre-serialized to keep that contract stable.
    expect(result).toBe(JSON.stringify({ awaiting: "location" }));
  });

  it("makes no HTTP calls", async () => {
    await askLocationTool.invoke({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
