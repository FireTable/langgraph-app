import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { confirmCryptoOrderTool } from "@/backend/tool/crypto/confirm-crypto-order";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("confirmCryptoOrderTool", () => {
  it("returns a simulated order with qty = amount_usd / price_at_confirm", async () => {
    const out = await confirmCryptoOrderTool.invoke({
      coin_id: "bitcoin",
      coin_symbol: "BTC",
      amount_usd: 100,
      price_at_confirm: 50000,
      side: "buy",
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.success).toBe(true);
    expect(parsed.order).toMatchObject({
      coin: "bitcoin",
      symbol: "BTC",
      amount_usd: 100,
      qty: 0.002,
      price_at_confirm: 50000,
      side: "buy",
      status: "simulated_filled",
    });
    expect(parsed.order.id).toMatch(/^ord_/);
    expect(parsed.order.timestamp).toMatch(/T/);
    expect(parsed.order.note).toMatch(/simulated/i);
  });

  it("supports the sell side", async () => {
    const out = await confirmCryptoOrderTool.invoke({
      coin_id: "ethereum",
      coin_symbol: "ETH",
      amount_usd: 50,
      price_at_confirm: 2500,
      side: "sell",
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.order.side).toBe("sell");
    expect(parsed.order.qty).toBe(0.02);
  });

  it("rejects a non-positive price with a structured error", async () => {
    const out = await confirmCryptoOrderTool.invoke({
      coin_id: "bitcoin",
      coin_symbol: "BTC",
      amount_usd: 100,
      price_at_confirm: 0,
      side: "buy",
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/price/);
  });

  it("rejects a non-positive amount with a structured error", async () => {
    const out = await confirmCryptoOrderTool.invoke({
      coin_id: "bitcoin",
      coin_symbol: "BTC",
      amount_usd: 0,
      price_at_confirm: 50000,
      side: "buy",
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/amount/);
  });

  it("makes no HTTP calls", async () => {
    await confirmCryptoOrderTool.invoke({
      coin_id: "bitcoin",
      coin_symbol: "BTC",
      amount_usd: 1,
      price_at_confirm: 1,
      side: "buy",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
