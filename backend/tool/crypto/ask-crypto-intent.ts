import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { interrupt } from "@langchain/langgraph";

export const ASK_CRYPTO_INTENT_TOOL_NAME = "ask_crypto_intent";

// ask_crypto_intent is a pure trigger. The tool pauses via interrupt; the
// frontend's addResult resumes with {coin_id, coin_symbol, amount, currency, side}
// or {error}, which becomes the ToolMessage content the LLM reads next pass.
// Shape mirrors AskCryptoIntentResult in components/tool-ui/crypto.
export const askCryptoIntentTool = tool(
  async ({ message = "Which crypto and how much?" } = {}) => {
    return interrupt({ ui: ASK_CRYPTO_INTENT_TOOL_NAME, data: {}, message });
  },
  {
    name: ASK_CRYPTO_INTENT_TOOL_NAME,
    description: `Render a buy/sell form card so the user can pick a coin and amount. Use this whenever the agent needs a trade intent to proceed — typically because the user asked to buy, sell, or "go long" a coin. Do NOT batch other tool calls in the same turn; the card pauses the turn until the user replies. Call this at most once per turn.

Detect the user's currency from the message (元/RMB/CNY/¥ → CNY, $/USD → USD, €/EUR, £/GBP, ¥/JPY) and pass it as \`currency\`. If the user named a specific amount, pass it as \`amount\` to pre-fill the input. If the currency is ambiguous, omit the field and the card will default to USD.`,
    schema: z.object({
      message: z.string().optional().describe("Short prompt shown above the form; one sentence."),
      currency: z
        .string()
        .length(3)
        .optional()
        .describe(
          "ISO 4217 currency code the user is thinking in (e.g. 'USD', 'CNY', 'EUR', 'JPY', 'GBP'). Detected from the message — 元/RMB → CNY, $/USD → USD, etc. Card displays the amount in this currency.",
        ),
      amount: z
        .number()
        .positive()
        .optional()
        .describe(
          "Pre-fill notional in the detected currency, only when the user named a specific amount. Card will pre-fill the amount input; the user can still edit.",
        ),
    }),
  },
);
