import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { geocodeLocation } from "@/lib/open-meteo";

// Geocode a place name into coordinates. Coordinates are not weather-
// specific — anything that needs a lat/lon (maps, news, sun, etc.) can
// reuse this tool, so it lives at the top level of backend/tool instead
// of nested under weather.
export const geocodeLocationTool = tool(
  async ({ query }: { query: string }) => {
    const result = await geocodeLocation(query);
    return JSON.stringify(result);
  },
  {
    name: "geocode_location",
    description:
      "Convert a place name (e.g. 'Beijing', '北京市海淀区', 'Springfield IL') into latitude/longitude. Returns { success, result: {name, latitude, longitude} } or { success: false, error }.",
    schema: z.object({
      query: z.string().min(1).describe("Place name as the user wrote it."),
    }),
  },
);
