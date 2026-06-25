import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { interrupt } from "@langchain/langgraph";
import { askCryptoIntentTool } from "@/backend/tool/crypto/ask-crypto-intent";

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

describe("askCryptoIntentTool", () => {
  it("pauses with ui: ask_crypto_intent and returns the resumed pick", async () => {
    const pick = {
      coin_id: "bitcoin",
      coin_symbol: "BTC",
      amount: 100,
      currency: "USD",
      side: "buy",
    };
    interruptMock.mockReturnValue(pick);

    const result = await askCryptoIntentTool.invoke({ message: "What do you want to buy?" });

    expect(interruptMock).toHaveBeenCalledWith({
      ui: "ask_crypto_intent",
      data: {},
      message: "What do you want to buy?",
    });
    expect(result).toEqual(pick);
  });

  it("forwards an error pick as the tool result", async () => {
    const errorPick = { error: "User cancelled" };
    interruptMock.mockReturnValue(errorPick);

    const result = await askCryptoIntentTool.invoke({ message: "?" });

    expect(result).toEqual(errorPick);
  });

  it("defaults the message when none is provided", async () => {
    interruptMock.mockReturnValue({
      coin_id: "bitcoin",
      coin_symbol: "BTC",
      amount: 1,
      currency: "USD",
      side: "buy",
    });
    await askCryptoIntentTool.invoke({});
    expect(interruptMock).toHaveBeenCalledWith(
      expect.objectContaining({ ui: "ask_crypto_intent", message: expect.any(String) }),
    );
  });

  it("forwards the detected currency and pre-fill amount to the card", async () => {
    interruptMock.mockReturnValue({
      coin_id: "bitcoin",
      coin_symbol: "BTC",
      amount: 100,
      currency: "CNY",
      side: "buy",
    });
    await askCryptoIntentTool.invoke({ message: "?", currency: "CNY", amount: 100 });
    expect(interruptMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "?", ui: "ask_crypto_intent" }),
    );
  });

  it("makes no HTTP calls", async () => {
    interruptMock.mockReturnValue({
      coin_id: "bitcoin",
      coin_symbol: "BTC",
      amount: 1,
      currency: "USD",
      side: "buy",
    });
    await askCryptoIntentTool.invoke({ message: "?" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
