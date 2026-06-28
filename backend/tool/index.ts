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

// ponytail: keep the tool list in one place so the graph binds it from a
// single source. Adding a tool = drop a file + add one line here.
//
// Trade flow is split into 3 atomic tools:
//   1. connect_wallet        — one-time wallet authorization (interrupt)
//   2. place_crypto_order    — randomized simulated swap (interrupt)
//   3. get_order_status      — order status check (interrupt)
// Each is its own user decision point and ToolMessage the LLM can reason
// about independently. Cards live in components/tool-ui/crypto/.

export const WEATHER_TOOLS = [askLocationTool, geocodeLocationTool, getWeatherTool];

export const CRYPTO_TOOLS = [
  getCryptoPriceTool,
  getFxRateTool,
  connectWalletTool,
  placeCryptoOrderTool,
  getOrderStatusTool,
];

export const ALL_TOOLS = [
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
};
