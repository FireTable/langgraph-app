import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { interrupt } from "@langchain/langgraph";

export const CONNECT_WALLET_TOOL_NAME = "connect_wallet";

// connect_wallet is a pure trigger. It pauses via interrupt(); the
// frontend card (ConnectWalletCard) opens RainbowKit, then resumes with
// {address, chainId} from wagmi — that becomes the ToolMessage content
// the LLM reads next pass. Subsequent tools (place_crypto_order,
// get_order_status) auto-infer the address from wagmi state, so the LLM
// does not need to thread it through the schema.
export const connectWalletTool = tool(
  async ({ message }) => {
    return interrupt({
      ui: CONNECT_WALLET_TOOL_NAME,
      data: {},
      message: message ?? "Connect your wallet to continue.",
    });
  },
  {
    name: CONNECT_WALLET_TOOL_NAME,
    description:
      "Pause and prompt the user to connect their wallet. The card opens RainbowKit; on success the wallet's address and chain id flow back via the ToolMessage. Call this at the start of any trade flow if the most recent connect_wallet ToolMessage in this thread does NOT contain a valid address. If the user already has a connected address from a previous turn, you may skip directly to place_crypto_order. Do NOT batch with any other tool — the user must click Connect before any state changes.",
    schema: z.object({
      message: z
        .string()
        .optional()
        .describe(
          "Short prompt shown above the connect button; one sentence. Defaults to a generic 'Connect your wallet to continue.' if omitted.",
        ),
    }),
  },
);
