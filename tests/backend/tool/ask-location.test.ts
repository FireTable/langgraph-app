import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { interrupt } from "@langchain/langgraph";
import { askLocationTool } from "@/backend/tool/ask-location";

vi.mock("@langchain/langgraph", async () => {
  const actual =
    await vi.importActual<typeof import("@langchain/langgraph")>("@langchain/langgraph");
  return {
    ...actual,
    interrupt: vi.fn(),
  };
});

const fetchMock = vi.fn();
const interruptMock = interrupt as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  interruptMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("askLocationTool", () => {
  it("pauses with ui: ask_location and returns the resumed pick", async () => {
    const pick = { lat: 39.9042, lon: 116.4074, label: "Beijing" };
    interruptMock.mockReturnValue(pick);

    const result = await askLocationTool.invoke({ message: "Where are you?" });

    expect(interruptMock).toHaveBeenCalledWith({
      ui: "ask_location",
      data: {},
      message: "Where are you?",
    });
    expect(result).toEqual(pick);
  });

  it("forwards an error pick as the tool result", async () => {
    const errorPick = { error: "Location permission denied" };
    interruptMock.mockReturnValue(errorPick);

    const result = await askLocationTool.invoke({ message: "Where are you?" });

    expect(result).toEqual(errorPick);
  });

  it("makes no HTTP calls", async () => {
    interruptMock.mockReturnValue({ lat: 0, lon: 0, label: "" });
    await askLocationTool.invoke({ message: "Where are you?" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
