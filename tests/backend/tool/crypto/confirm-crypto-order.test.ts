import { describe, it, expect } from "vitest";

import { confirmCryptoOrderTool } from "@/backend/tool/crypto/confirm-crypto-order";

// The tool is a pure pause: it validates the LLM's intent and emits
// `{status:"awaiting_user", intent:{...}}`. No fetch, no chain calls —
// the card does all the wallet + quote work client-side.

describe("confirmCryptoOrderTool — intent pause", () => {
  it("emits awaiting_user with the intent payload verbatim", async () => {
    const out = await confirmCryptoOrderTool.invoke({
      side: "sell",
      source_coin_id: "usd-coin",
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.status).toBe("awaiting_user");
    expect(parsed.intent).toEqual({
      side: "sell",
      source_coin_id: "usd-coin",
      amount: null,
      target_coin_id: null,
    });
  });

  it("forwards amount + target_coin_id when the LLM names them", async () => {
    const out = await confirmCryptoOrderTool.invoke({
      side: "sell",
      source_coin_id: "usd-coin",
      amount: 100,
      target_coin_id: "ethereum",
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.intent).toEqual({
      side: "sell",
      source_coin_id: "usd-coin",
      amount: 100,
      target_coin_id: "ethereum",
    });
  });

  it("works with no optional fields at all (the card picks defaults from the wallet)", async () => {
    const out = await confirmCryptoOrderTool.invoke({ side: "buy" });
    const parsed = JSON.parse(out as string);
    expect(parsed.status).toBe("awaiting_user");
    expect(parsed.intent.source_coin_id).toBeNull();
    expect(parsed.intent.amount).toBeNull();
    expect(parsed.intent.target_coin_id).toBeNull();
  });
});

describe("confirmCryptoOrderTool — validation", () => {
  it("rejects a non-positive amount at the schema layer", async () => {
    await expect(confirmCryptoOrderTool.invoke({ side: "sell", amount: 0 })).rejects.toThrow();
  });

  it("rejects NaN amount at the schema layer", async () => {
    await expect(
      confirmCryptoOrderTool.invoke({ side: "sell", amount: Number.NaN }),
    ).rejects.toThrow();
  });

  it("rejects a malformed CoinGecko id", async () => {
    const out = await confirmCryptoOrderTool.invoke({
      side: "sell",
      source_coin_id: "Bad/Id With Spaces",
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.status).toBe("error");
    expect(parsed.error).toMatch(/source_coin_id/);
  });

  it("rejects a CoinGecko id not in the catalog", async () => {
    const out = await confirmCryptoOrderTool.invoke({
      side: "sell",
      source_coin_id: "definitely-not-a-real-coin",
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.status).toBe("error");
    expect(parsed.error).toMatch(/catalog/);
  });
});
