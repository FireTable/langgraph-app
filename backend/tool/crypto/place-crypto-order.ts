import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { interrupt } from "@langchain/langgraph";

export const PLACE_CRYPTO_ORDER_TOOL_NAME = "place_crypto_order";

// place_crypto_order is a pure trigger for the simulated swap flow.
// The tool pauses via interrupt(); the frontend card
// (PlaceCryptoOrderCard) renders a swap quote against Mock Coin (the
// hardcoded source), prices the user's target via live CoinGecko, lets
// the user pick slippage + simulated gas tier, and on user click resumes
// with a synthesized {status:"simulated_filled", order:{...}} object.
// The tool returns that object to the LLM as-is — no real signing, no
// real on-chain transaction. The user is told upfront this is a SIMULATED
// swap; the user starts with 10,000 Mock Coin (hardcoded balance, no
// wallet lookup).

const COIN_ID_RE = /^[a-z0-9-]+$/;

export const placeCryptoOrderTool = tool(
  async ({ target_coin_id, amount, message }) => {
    if (target_coin_id && !COIN_ID_RE.test(target_coin_id)) {
      throw new Error(`target_coin_id '${target_coin_id}' is not a valid CoinGecko id`);
    }

    const intent = {
      target_coin_id: target_coin_id ?? null,
      amount: amount ?? null,
    };
    return interrupt({
      ui: PLACE_CRYPTO_ORDER_TOOL_NAME,
      data: intent,
      message,
    });
  },
  {
    name: PLACE_CRYPTO_ORDER_TOOL_NAME,
    description:
      "Render a simulated swap quote card and pause for the user to click Accept Swap. The LLM parses the user's intent and passes target_coin_id (required) + amount (optional) here; the card always spends Mock Coin (no wallet balance lookup — the user is auto-funded with 10,000 MC), prices the target via live CoinGecko USD, polls every 30s with a visible countdown, and lets the user pick slippage + simulated gas tier (gas is converted to MC at the live ETH/USD price so the receipt shows total MC spent). The user is told upfront this is a SIMULATED swap; no real signing happens, no real funds move, nothing is broadcast on-chain. The closing ToolMessage (status: simulated_filled | cancelled | error) is what the model uses to write the final sentence. Call this AFTER connect_wallet has resolved in this thread. Do NOT batch with any other tool.",
    schema: z.object({
      target_coin_id: z
        .string()
        .min(1)
        .describe(
          "CoinGecko id of what the user wants to receive (e.g. 'ethereum' for ETH, 'bitcoin' for BTC, 'dogecoin' for DOGE, 'solana' for SOL). REQUIRED — the source is always Mock Coin, hardcoded. Any CoinGecko id is accepted; there is no allowlist.",
        ),
      amount: z
        .number()
        .positive()
        .optional()
        .describe(
          "Mock Coin amount the user wants to spend (e.g. 100 for 100 MC ≈ $100). Omit when the user didn't name a number — defaults to 100 MC.",
        ),
      message: z
        .string()
        .min(1)
        .describe(
          "REQUIRED. A short, intent-specific prose line the LLM composes for this turn (e.g. 'Swapping 100 MC for ETH' or 'Converting $50 to BTC'). This is the message the user sees next to the quote card so it reflects the user's actual intent, not a fixed string.",
        ),
    }),
  },
);
