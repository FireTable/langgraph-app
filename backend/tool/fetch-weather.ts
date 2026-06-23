import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { fetchWeatherWidget } from "@/lib/open-meteo";

export const getWeatherTool = tool(
  async ({
    latitude,
    longitude,
    location,
    unit,
  }: {
    latitude: number;
    longitude: number;
    location: string;
    unit?: "celsius" | "fahrenheit";
  }) => {
    const result = await fetchWeatherWidget({
      query: location,
      latitude,
      longitude,
      unit,
    });
    return JSON.stringify(result);
  },
  {
    name: "get_weather",
    description:
      "Fetch the current weather + 5-day forecast for coordinates. Returns { success, widget: WeatherWidgetPayload } or { success: false, error }. Always call geocode_location (or receive coords from ask_location) first.",
    schema: z.object({
      location: z.string().describe("Display name for the location."),
      latitude: z.number().describe("Latitude from geocode_location or ask_location."),
      longitude: z.number().describe("Longitude from geocode_location or ask_location."),
      unit: z
        .enum(["celsius", "fahrenheit"])
        .optional()
        .describe("Temperature unit. Pick celsius for zh-* locales, fahrenheit for en-*. Defaults to celsius."),
    }),
  },
);
