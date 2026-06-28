import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { interrupt } from "@langchain/langgraph";
import { getOrderStatusTool } from "@/backend/tool/crypto/get-order-status";

// get_order_status is a pure trigger. The tool pauses via interrupt();
// the frontend card (OrderStatusCard) shows the order uid and on click
// synthesizes a status (since this is a fully simulated demo, no
// on-chain /orders endpoint is queried). The tool returns the
// synthesized status to the LLM as-is.

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

describe("getOrderStatusTool", () => {
  it("pauses with ui: get_order_status and returns the synthesized status from the card", async () => {
    const resume = {
      status: "filled" as const,
      order_uid: "0xabc123",
      chain_id: 8453,
      filled_buy_amount: "25500000",
      executed_at: "2026-06-27T20:01:00.000Z",
    };
    interruptMock.mockReturnValue(resume);

    const result = await getOrderStatusTool.invoke({
      order_uid: "0xabc123",
      chain_id: 8453,
      message: "Checking the ETH quote status",
    });

    expect(interruptMock).toHaveBeenCalledWith({
      ui: "get_order_status",
      data: { order_uid: "0xabc123", chain_id: 8453 },
      message: "Checking the ETH quote status",
    });
    expect(result).toEqual(resume);
  });

  it("forwards an 'open' status unchanged", async () => {
    interruptMock.mockReturnValue({ status: "open", order_uid: "0xabc", chain_id: 1 });
    const result = await getOrderStatusTool.invoke({
      order_uid: "0xabc",
      chain_id: 1,
      message: "status check",
    });
    expect(result).toEqual({ status: "open", order_uid: "0xabc", chain_id: 1 });
  });

  it("forwards a 'not_found' / 'cancelled' terminal state", async () => {
    interruptMock.mockReturnValue({ status: "not_found", order_uid: "0xabc", chain_id: 1 });
    const result = await getOrderStatusTool.invoke({
      order_uid: "0xabc",
      chain_id: 1,
      message: "status check",
    });
    expect(result.status).toBe("not_found");
  });

  it("makes no HTTP calls — status is synthesized client-side", async () => {
    interruptMock.mockReturnValue({ status: "filled", order_uid: "0xabc", chain_id: 1 });
    await getOrderStatusTool.invoke({
      order_uid: "0xabc",
      chain_id: 1,
      message: "status check",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty order_uid at the schema layer", async () => {
    await expect(
      getOrderStatusTool.invoke({ order_uid: "", chain_id: 1, message: "x" }),
    ).rejects.toThrow();
  });

  it("rejects a non-numeric chain_id at the schema layer", async () => {
    await expect(
      getOrderStatusTool.invoke({
        order_uid: "0xabc",
        chain_id: Number.NaN,
        message: "x",
      }),
    ).rejects.toThrow();
  });
});
