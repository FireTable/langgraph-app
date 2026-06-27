import { fetchUrl } from "@/backend/tool/web-fetch";
import { searchWeb } from "@/backend/tool/web-search";
import { askLocationTool } from "@/backend/tool/ask-location";
import { geocodeLocationTool } from "@/backend/tool/geocode";
import { getWeatherTool } from "@/backend/tool/fetch-weather";
import { getCryptoPriceTool } from "@/backend/tool/crypto/get-crypto-price";
import { getFxRateTool } from "@/backend/tool/crypto/get-fx-rate";
import { confirmCryptoOrderTool } from "@/backend/tool/crypto/confirm-crypto-order";

// ponytail: keep the tool list in one place so the graph binds it from a
// single source. Adding a tool = drop a file + add one line here.
//
// Note: get_swap_quote + ask_crypto_intent were folded into
// confirm_crypto_order. The card now reads wagmi/Alchemy + fetches CoW
// quotes client-side; the backend only emits the intent pause.

export const WEATHER_TOOLS = [askLocationTool, geocodeLocationTool, getWeatherTool];

export const CRYPTO_TOOLS = [getCryptoPriceTool, getFxRateTool, confirmCryptoOrderTool];

export const ALL_TOOLS = [
  fetchUrl,
  searchWeb,
  askLocationTool,
  geocodeLocationTool,
  getWeatherTool,
  getCryptoPriceTool,
  getFxRateTool,
  confirmCryptoOrderTool,
];

export {
  fetchUrl,
  searchWeb,
  askLocationTool,
  geocodeLocationTool,
  getWeatherTool,
  getCryptoPriceTool,
  getFxRateTool,
  confirmCryptoOrderTool,
};
