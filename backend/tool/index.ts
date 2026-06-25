import { fetchUrl } from "@/backend/tool/web-fetch";
import { searchWeb } from "@/backend/tool/web-search";
import { askLocationTool } from "@/backend/tool/ask-location";
import { geocodeLocationTool } from "@/backend/tool/geocode";
import { getWeatherTool } from "@/backend/tool/fetch-weather";

// ponytail: keep the tool list in one place so the graph binds it from a
// single source. Adding a tool = drop a file + add one line here.

export const WEATHER_TOOLS = [askLocationTool, geocodeLocationTool, getWeatherTool];

export const ALL_TOOLS = [
  fetchUrl,
  searchWeb,
  askLocationTool,
  geocodeLocationTool,
  getWeatherTool,
];

export { fetchUrl, searchWeb, askLocationTool, geocodeLocationTool, getWeatherTool };
