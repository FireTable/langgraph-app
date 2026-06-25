import { randomUUID } from "node:crypto";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

// ponytail: simulated order — no signing, no chain, no RPC. The frontend
// card shows a "Simulated Filled" badge and a "view on Etherscan" link
// that's disabled. Upgrade path: swap body for wagmi useWriteContract
// calling a Uniswap V3 Router (needs RPC + Router address in env).

export const confirmCryptoOrderTool = tool(
  async ({
    coin_id,
    coin_symbol,
    amount_usd,
    price_at_confirm,
    side,
  }: {
    coin_id: string;
    coin_symbol: string;
    amount_usd: number;
    price_at_confirm: number;
    side: "buy" | "sell";
  }) => {
    if (amount_usd <= 0) {
      return JSON.stringify({ success: false, error: "amount_usd must be > 0" });
    }
    if (price_at_confirm <= 0) {
      return JSON.stringify({ success: false, error: "price_at_confirm must be > 0" });
    }

    const qty = amount_usd / price_at_confirm;
    return JSON.stringify({
      success: true,
      order: {
        id: `ord_${randomUUID()}`,
        coin: coin_id,
        symbol: coin_symbol,
        side,
        amount_usd,
        qty,
        price_at_confirm,
        status: "simulated_filled",
        timestamp: new Date().toISOString(),
        note: "This is a simulated order. No on-chain transaction was sent.",
      },
    });
  },
  {
    name: "confirm_crypto_order",
    description:
      "Finalize a simulated crypto order. Call only after ask_crypto_intent returned a valid pick and get_crypto_price gave the current price. Returns a fake order receipt — no signing, no chain.",
    schema: z.object({
      coin_id: z.string().describe("CoinGecko coin id, e.g. 'bitcoin'."),
      coin_symbol: z.string().describe("Ticker, e.g. 'BTC'."),
      amount_usd: z.number().describe("Notional in USD the user wants to trade."),
      price_at_confirm: z
        .number()
        .describe("Spot price observed from the most recent get_crypto_price call."),
      side: z.enum(["buy", "sell"]).describe("Trade direction."),
    }),
  },
);
