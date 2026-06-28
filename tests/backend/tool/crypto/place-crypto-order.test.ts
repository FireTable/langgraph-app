import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { interrupt } from "@langchain/langgraph";
import { placeCryptoOrderTool } from "@/backend/tool/crypto/place-crypto-order";

// place_crypto_order is a pure trigger. The tool pauses via interrupt();
// the frontend card (PlaceCryptoOrderCard) renders a quote against Mock
// Coin (10,000 MC hardcoded balance — no wallet lookup), prices the
// target via live CoinGecko, and on user click resumes with a synthesized
// {status:"simulated_filled", order} object. The tool returns that object
// to the LLM as-is. The schema now only takes target_coin_id + amount —
// the source is hardcoded to Mock Coin in the card.

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

describe("placeCryptoOrderTool", () => {
  it("pauses with ui: place_crypto_order and returns the simulated fill from the card", async () => {
    const resume = {
      status: "simulated_filled" as const,
      order: {
        id: "ord_test_123",
        source_coin_id: "mock-coin",
        target_coin_id: "ethereum",
        target_symbol: "ETH",
        amount_mc: 100,
        gas_fee_mc: 0.28,
        total_mc: 100.28,
        qty: 0.0636,
        status: "simulated_filled",
        timestamp: "2026-06-27T20:00:00.000Z",
        note: "Simulated swap. Spent 100 MC + 0.28 MC gas. Nothing was signed or broadcast on-chain.",
        slippage_bps: 50,
        gas_tier: "standard",
        gas_fee_eth: 0.00018,
      },
    };
    interruptMock.mockReturnValue(resume);

    const result = await placeCryptoOrderTool.invoke({
      target_coin_id: "ethereum",
      amount: 100,
      message: "Swapping 100 MC for ETH",
    });

    expect(interruptMock).toHaveBeenCalledWith({
      ui: "place_crypto_order",
      data: {
        target_coin_id: "ethereum",
        amount: 100,
      },
      message: "Swapping 100 MC for ETH",
    });
    expect(result).toEqual(resume);
  });

  it("forwards a cancelled resume (user clicked Cancel)", async () => {
    const resume = { status: "cancelled" as const };
    interruptMock.mockReturnValue(resume);
    const result = await placeCryptoOrderTool.invoke({
      target_coin_id: "ethereum",
      message: "ETH swap",
    });
    expect(result).toEqual(resume);
  });

  it("forwards an error resume (card-level failure)", async () => {
    const resume = { status: "error" as const, error: "CoinGecko unreachable" };
    interruptMock.mockReturnValue(resume);
    const result = await placeCryptoOrderTool.invoke({
      target_coin_id: "ethereum",
      message: "ETH swap",
    });
    expect(result).toEqual(resume);
  });

  it("makes no HTTP calls — the card fetches prices client-side", async () => {
    interruptMock.mockReturnValue({ status: "cancelled" });
    await placeCryptoOrderTool.invoke({
      target_coin_id: "ethereum",
      message: "ETH swap",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("works with only target_coin_id (amount defaults to 100 MC in the card)", async () => {
    interruptMock.mockReturnValue({ status: "cancelled" });
    const result = await placeCryptoOrderTool.invoke({
      target_coin_id: "ethereum",
      message: "ETH swap",
    });
    expect(result).toEqual({ status: "cancelled" });
  });

  it("rejects a malformed target CoinGecko id at the schema layer", async () => {
    await expect(
      placeCryptoOrderTool.invoke({
        target_coin_id: "Bad Id With Spaces",
        message: "bad id",
      }),
    ).rejects.toThrow();
  });

  it("rejects a non-positive amount at the schema layer", async () => {
    await expect(
      placeCryptoOrderTool.invoke({
        target_coin_id: "ethereum",
        amount: 0,
        message: "zero amount",
      }),
    ).rejects.toThrow();
  });

  it("rejects a missing message at the schema layer", async () => {
    // The schema declares message as required — we bypass TS to test the
    // runtime contract (LangGraph's structured-tool validation path).
    await expect(
      placeCryptoOrderTool.invoke({ target_coin_id: "ethereum" } as never),
    ).rejects.toThrow();
  });
});
