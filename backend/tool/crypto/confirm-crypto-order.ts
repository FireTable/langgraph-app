import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { resolveToken } from "@/lib/tokens/catalog";

// The LLM's only job in the trade flow is to parse the user's intent.
// Everything wallet-related (balances, chain, address) is read by the
// frontend card from wagmi. Everything price-related (quote, fees) is
// fetched client-side from CoW. The tool is a pure pause:
//
//   1. LLM emits `confirm_swap(side, source?, amount?, target?)`.
//   2. Tool returns `{status:"awaiting_user", intent:{...}}`. The card
//      renders with the user's actual wallet balances + a live CoW
//      quote.
//   3. User clicks Sign → card signs EIP-712 + POSTs to CoW + calls
//      addResult({status:"signed" | "simulated_filled" | "cancelled" |
//      "error", ...}). The LLM then writes the closing sentence.
//
// Why merge the old `ask_crypto_intent` + `confirm_crypto_order`?
// Previously the user had to fill a buy/sell form, click Confirm, see
// the quote card, then click Sign. Two clicks, two cards, and the
// first form was useless the moment the LLM already knew side +
// source from the message. The wallet-aware card subsumes both: it
// shows real balances, picks a sensible target, fetches the live
// quote, and exposes one Sign button.

export type SwapIntent = {
  side: "buy" | "sell";
  source_coin_id: string | null;
  amount: number | null;
  target_coin_id: string | null;
};

const COIN_ID_RE = /^[a-z0-9-]+$/;

export const confirmCryptoOrderTool = tool(
  async ({ side, source_coin_id, amount, target_coin_id }) => {
    // Validate that the named tokens exist on SOME supported chain.
    // The frontend card resolves chain from wagmi; we can't validate
    // chain availability here without that info, but we can catch
    // obviously bogus CoinGecko ids early.
    if (source_coin_id && !COIN_ID_RE.test(source_coin_id)) {
      return JSON.stringify({
        status: "error",
        error: `source_coin_id '${source_coin_id}' is not a valid CoinGecko id`,
      });
    }
    if (target_coin_id && !COIN_ID_RE.test(target_coin_id)) {
      return JSON.stringify({
        status: "error",
        error: `target_coin_id '${target_coin_id}' is not a valid CoinGecko id`,
      });
    }
    // Light chain sanity check — every supported chain has at least one
    // token in the catalog. If neither source nor target is named, we
    // still let the card proceed (it picks defaults from the wallet).
    if (source_coin_id || target_coin_id) {
      const probe = source_coin_id ?? target_coin_id!;
      const okOnMainnet = resolveToken(probe, 1) != null;
      if (!okOnMainnet) {
        return JSON.stringify({
          status: "error",
          error: `coin_id '${probe}' is not in the supported token catalog`,
        });
      }
    }

    const intent: SwapIntent = {
      side,
      source_coin_id: source_coin_id ?? null,
      amount: amount ?? null,
      target_coin_id: target_coin_id ?? null,
    };
    return JSON.stringify({ status: "awaiting_user", intent });
  },
  {
    name: "confirm_crypto_order",
    description:
      "Render a wallet-aware swap card and pause for the user to sign. The LLM parses the user's intent (side + optional source token / amount / target) and passes it here; the card wakes the wallet (RainbowKit modal if not connected), lists the user's actual balances from Alchemy, picks a sensible default target if none was named, fetches a live CoW quote, and exposes one Sign & Place Order button. The user must click before any state changes — the closing ToolMessage (signed / simulated_filled / cancelled / error) is what the model uses to write the final sentence. Pass source_coin_id (CoinGecko id) only when the user named a source token; pass amount only when the user named a number; pass target_coin_id only when the user named what they want to receive. Do NOT batch with any other tool.",
    schema: z.object({
      side: z
        .enum(["buy", "sell"])
        .describe(
          "Trade direction inferred from the user's message. 'sell my X' / 'swap X for Y' → sell (you're spending X). 'buy Y with X' → buy (you're acquiring Y).",
        ),
      source_coin_id: z
        .string()
        .optional()
        .describe(
          "CoinGecko id of the source token the user named (e.g. 'usd-coin' for USDC, 'ethereum' for WETH, 'wrapped-bitcoin' for WBTC). Omit when the user didn't name one — the card picks from the user's wallet holdings.",
        ),
      amount: z
        .number()
        .positive()
        .optional()
        .describe(
          "Human-readable amount the user named (e.g. 100 for 100 USDC, 0.1 for 0.1 WETH). Omit when the user didn't name a number — the card defaults to 'all of it' for sell, leaves blank for buy.",
        ),
      target_coin_id: z
        .string()
        .optional()
        .describe(
          "CoinGecko id of the target token the user wants to receive (e.g. 'ethereum' for WETH). Omit when the user didn't name a target — the card picks a sensible default (WETH for stablecoin sellers, USDC for ETH/WBTC sellers).",
        ),
    }),
  },
);
