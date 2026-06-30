import { fetchUrl } from "@/backend/tool/web-fetch";
import { searchWeb } from "@/backend/tool/web-search";
import { askLocationTool } from "@/backend/tool/ask-location";
import { geocodeLocationTool } from "@/backend/tool/geocode";
import { getWeatherTool } from "@/backend/tool/fetch-weather";
import { getCryptoPriceTool } from "@/backend/tool/crypto/get-crypto-price";
import { getFxRateTool } from "@/backend/tool/crypto/get-fx-rate";
import { connectWalletTool } from "@/backend/tool/crypto/connect-wallet";
import { placeCryptoOrderTool } from "@/backend/tool/crypto/place-crypto-order";
import { getOrderStatusTool } from "@/backend/tool/crypto/get-order-status";
import { getNftHoldingsTool } from "@/backend/tool/crypto/get-nft-holdings";
import { getCodeTools } from "@/backend/tool/code";

// ponytail: keep the tool list in one place so the graph binds it from a
// single source. Adding a tool = drop a file + add one line here.
//
// Trade flow is split into 3 atomic tools:
//   1. connect_wallet        — one-time wallet authorization (interrupt)
//   2. place_crypto_order    — randomized simulated swap (interrupt)
//   3. get_order_status      — order status check (interrupt)
// Each is its own user decision point and ToolMessage the LLM can reason
// about independently. Cards live in components/tool-ui/crypto/.
//
// Tools that need a third-party key (search_web → JINA_API_KEYS,
// get_NFT_holdings → ALCHEMY_API_KEY) are gated: they return `null`
// when the key is missing, and the spreads below skip them. `fetch_url`
// is unconditional because r.jina.ai accepts unauthenticated requests
// on the free tier (lower rate limit, no key needed).

export const WEATHER_TOOLS = [askLocationTool, geocodeLocationTool, getWeatherTool];

export const CRYPTO_TOOLS = [
  getCryptoPriceTool,
  getFxRateTool,
  connectWalletTool,
  placeCryptoOrderTool,
  getOrderStatusTool,
  ...(getNftHoldingsTool ? [getNftHoldingsTool] : []),
];

// Code agent owns write_code (Step 1 — propose) and execute_code (Step 2 — run).
// execute_code is gated on DENO_DEPLOY_TOKEN via the lazy register in
// backend/tool/code/execute-code.ts; getCodeTools() reads the env once at
// module load so a missing token just drops the runner, the model keeps
// proposing code, and a friendly prose fallback runs at click-time.
export const CODE_TOOLS = getCodeTools();

export const ALL_TOOLS = [
  fetchUrl,
  ...(searchWeb ? [searchWeb] : []),
  askLocationTool,
  geocodeLocationTool,
  getWeatherTool,
  getCryptoPriceTool,
  getFxRateTool,
  connectWalletTool,
  placeCryptoOrderTool,
  getOrderStatusTool,
  ...(getNftHoldingsTool ? [getNftHoldingsTool] : []),
];

export {
  fetchUrl,
  searchWeb,
  askLocationTool,
  geocodeLocationTool,
  getWeatherTool,
  getCryptoPriceTool,
  getFxRateTool,
  connectWalletTool,
  placeCryptoOrderTool,
  getOrderStatusTool,
  getNftHoldingsTool,
};
