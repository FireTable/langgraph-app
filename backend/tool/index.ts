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
import { saveMemoryTool } from "@/backend/tool/memory/save-memory-tool";
import { lookupThreadMessagesTool } from "@/backend/tool/memory/lookup-thread-messages-tool";
import { executeCodeTool, writeCodeTool } from "@/backend/tool/code";
import { listDocumentsTool, searchKbTool } from "@/backend/tool/kb";
import { generateImageTool } from "@/backend/tool/image";

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
// is unconditional because r.jina.ai accepts unauthenticated requests on
// the free tier (lower rate limit, no key needed).
//
// KB tools (issue #13 v3):
//   - search_KB — gated on pgvector extension (rule #10).
//   - list_documents — pure SQL, always available.

export const MEMORY_TOOLS = [saveMemoryTool, lookupThreadMessagesTool];

export const WEATHER_TOOLS = [
  askLocationTool,
  geocodeLocationTool,
  getWeatherTool,
  ...MEMORY_TOOLS,
];

export const CRYPTO_TOOLS = [
  getCryptoPriceTool,
  getFxRateTool,
  connectWalletTool,
  placeCryptoOrderTool,
  getOrderStatusTool,
  ...(getNftHoldingsTool ? [getNftHoldingsTool] : []),
  ...MEMORY_TOOLS,
];

// Code agent owns write_code (Step 1 — propose) and execute_code (Step 2 — run).
// execute_code is gated on DENO_DEPLOY_TOKEN via the lazy register in
// backend/tool/code/execute-code.ts — a missing token drops the runner
// from this list, the model keeps proposing code, and a friendly prose
// fallback runs at click-time.
export const CODE_TOOLS = [
  writeCodeTool,
  ...(executeCodeTool ? [executeCodeTool] : []),
  lookupThreadMessagesTool,
];

// ponytail: KB tools — search_KB throws at runtime when pgvector is
// missing (the tool is still registered so the LLM sees a consistent
// tool surface; missing-extension produces a clean error message instead
// of a 500). list_documents is unconditional.
export const KB_TOOLS = [searchKbTool, listDocumentsTool];

export const CHAT_TOOLS = [
  fetchUrl,
  ...(searchWeb ? [searchWeb] : []),
  ...WEATHER_TOOLS,
  ...CRYPTO_TOOLS,
  ...KB_TOOLS,
  // ponytail: generate_image registered unconditionally — mock-first
  // pattern. The impl returns a placehold.co URL when FAL_KEY is
  // missing so local dev works end-to-end without a key. This is NOT
  // rule #10's free-tier exemption (that's fetch_url → r.jina.ai,
  // which genuinely serves unauthenticated traffic); fal.ai is paid,
  // we just ship a mock so dev doesn't need a key. Last in the list
  // so chatAgent's primary tool surface stays text-first. Future
  // image skills (regenerate, edit) drop into backend/tool/image/
  // and re-export from the barrel.
  generateImageTool,
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
  saveMemoryTool,
  lookupThreadMessagesTool,
  searchKbTool,
  listDocumentsTool,
  // ponytail: image tools live in backend/tool/image/; import above
  // pulls them via the barrel so future skills (regenerate, edit)
  // just need a re-export from the barrel.
  generateImageTool,
};
