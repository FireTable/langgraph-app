import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { interrupt } from "@langchain/langgraph";
import { connectWalletTool } from "@/backend/tool/crypto/connect-wallet";

// connect_wallet is a pure interrupt tool — pauses via interrupt(), the
// frontend card resumes with {address, chainId} (from wagmi), and the
// tool returns the same shape to the LLM.

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

describe("connectWalletTool", () => {
  it("pauses with ui: connect_wallet and returns the resumed address", async () => {
    const resumed = {
      address: "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01",
      chainId: 8453,
    };
    interruptMock.mockReturnValue(resumed);

    const result = await connectWalletTool.invoke({ message: "Connect to swap." });

    expect(interruptMock).toHaveBeenCalledWith({
      ui: "connect_wallet",
      data: {},
      message: "Connect to swap.",
    });
    expect(result).toEqual(resumed);
  });

  it("uses a default message when the LLM omits one", async () => {
    interruptMock.mockReturnValue({ address: "0xa", chainId: 1 });
    await connectWalletTool.invoke({});
    expect(interruptMock).toHaveBeenCalledWith({
      ui: "connect_wallet",
      data: {},
      message: expect.any(String) as string,
    });
  });

  it("forwards an error resume (user cancelled / wallet not installed)", async () => {
    const errorPick = { error: "user rejected connection" };
    interruptMock.mockReturnValue(errorPick);
    const result = await connectWalletTool.invoke({ message: "Connect." });
    expect(result).toEqual(errorPick);
  });

  it("forwards the card's cancel pick ({error: 'cancelled'}) so the LLM can branch", async () => {
    interruptMock.mockReturnValue({ error: "cancelled" });
    const result = await connectWalletTool.invoke({ message: "Connect to swap." });
    expect(result).toEqual({ error: "cancelled" });
  });

  it("makes no HTTP calls", async () => {
    interruptMock.mockReturnValue({ address: "0xa", chainId: 1 });
    await connectWalletTool.invoke({ message: "Connect." });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
