import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { interrupt } from "@langchain/langgraph";

export const ASK_LOCATION_TOOL_NAME = "ask_location";

// ask_location is a pure trigger. The tool pauses via interrupt; the
// frontend's addResult resumes with {lat, lon, label} or {error},
// which becomes the ToolMessage content the LLM reads next pass.
// Shape mirrors AskLocationResult in ask-location-card.tsx.
export const askLocationTool = tool(
  async ({ message = "Please share your location." }) => {
    return interrupt({ ui: ASK_LOCATION_TOOL_NAME, data: {}, message });
  },
  {
    name: ASK_LOCATION_TOOL_NAME,
    description: `Render a location picker card so the user can share a place. Use this whenever the agent needs a geographic location to proceed — typically because the request implies a place (weather, nearby search, directions, distance, "around here", etc.) but no place was named. Do NOT batch other tool calls in the same turn; the picker pauses the turn until the user replies. Call this at most once per turn.`,
    schema: z.object({
      message: z.string().describe("Short prompt shown above the picker; one sentence."),
    }),
  },
);
