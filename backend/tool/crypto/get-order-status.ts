import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { interrupt } from "@langchain/langgraph";

export const GET_ORDER_STATUS_TOOL_NAME = "get_order_status";

// get_order_status is a pure trigger for the simulated swap flow. The
// tool pauses via interrupt(); the frontend card (OrderStatusCard)
// shows the quote uid + chain, and on user click synthesizes a status
// (the synthetic uid from place_crypto_order isn't a real on-chain
// order, so there's nothing to query). The synthesized status flows
// back to the LLM as-is via the resume.

export const getOrderStatusTool = tool(
  async ({ order_uid, chain_id, message }) => {
    return interrupt({
      ui: GET_ORDER_STATUS_TOOL_NAME,
      data: { order_uid, chain_id },
      message,
    });
  },
  {
    name: GET_ORDER_STATUS_TOOL_NAME,
    description:
      "Render a swap status card for a previously accepted quote and pause for the user to click Check. The LLM passes the order_uid (returned by place_crypto_order) and chain_id (EVM chain id: 1, 42161, 8453, or 11155111). The card shows the quote uid and on user click synthesizes a status (filled / open / cancelled / not_found) — this is a simulated-swap demo, so the status is fabricated rather than queried from any chain. The closing ToolMessage status field is what the model uses to write the final sentence. Call this AFTER place_crypto_order has returned status:'simulated_filled' with an order_uid. If the status is still 'open', do NOT loop — reply to the user and let them decide whether to check again. Do NOT batch with any other tool.",
    schema: z.object({
      order_uid: z
        .string()
        .min(1)
        .describe(
          "The order uid returned by place_crypto_order (a 0x-prefixed hex string). Required.",
        ),
      chain_id: z
        .number()
        .int()
        .describe(
          "EVM chain id where the order was placed: 1 (Ethereum), 42161 (Arbitrum), 8453 (Base), or 11155111 (Sepolia testnet). Required.",
        ),
      message: z
        .string()
        .min(1)
        .describe(
          "REQUIRED. A short, intent-specific prose line the LLM composes for this turn (e.g. 'Checking the ETH quote from a moment ago' or 'Looking up that BTC swap status'). This is the message the user sees next to the status card so it reflects the user's actual intent, not a fixed string.",
        ),
    }),
  },
);
