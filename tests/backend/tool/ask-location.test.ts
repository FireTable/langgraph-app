import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockInterrupt } = vi.hoisted(() => ({
  mockInterrupt: vi.fn(),
}));

vi.mock("@langchain/langgraph", async () => {
  const actual = await vi.importActual<typeof import("@langchain/langgraph")>("@langchain/langgraph");
  return {
    ...actual,
    interrupt: (...args: unknown[]) => mockInterrupt(...args),
  };
});

import { askLocationTool } from "@/backend/tool/ask-location";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  mockInterrupt.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("askLocationTool", () => {
  it("first call: surfaces the awaiting marker via interrupt() and makes no HTTP calls", async () => {
    const interruptError = new Error("GraphInterrupt: paused");
    mockInterrupt.mockImplementationOnce(() => {
      throw interruptError;
    });

    await expect(askLocationTool.invoke({})).rejects.toBe(interruptError);
    expect(mockInterrupt).toHaveBeenCalledWith({ awaiting: "location" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resumed call with valid coords payload: returns the parsed coords", async () => {
    mockInterrupt.mockReturnValueOnce(
      JSON.stringify({ lat: 39.9042, lon: 116.4074, label: "Beijing" }),
    );

    const result = await askLocationTool.invoke({});
    expect(result).toEqual({ lat: 39.9042, lon: 116.4074, label: "Beijing" });
  });

  it("resumed call with error payload: returns the error string", async () => {
    mockInterrupt.mockReturnValueOnce(JSON.stringify({ error: "Location permission denied" }));

    const result = await askLocationTool.invoke({});
    expect(result).toEqual({ error: "Location permission denied" });
  });

  it("resumed call with a non-string resume value: parses the raw value", async () => {
    mockInterrupt.mockReturnValueOnce({ lat: 1, lon: 2, label: "x" });

    const result = await askLocationTool.invoke({});
    expect(result).toEqual({ lat: 1, lon: 2, label: "x" });
  });

  it("resumed call with malformed JSON: surfaces an error to the model", async () => {
    mockInterrupt.mockReturnValueOnce("not-json{{");

    const result = await askLocationTool.invoke({});
    expect(result).toEqual({ error: "Invalid location payload" });
  });

  it("resumed call with a payload missing required fields: surfaces an error to the model", async () => {
    mockInterrupt.mockReturnValueOnce(JSON.stringify({ lat: 1 }));

    const result = await askLocationTool.invoke({});
    expect(result).toEqual({ error: "Invalid location payload" });
  });
});
