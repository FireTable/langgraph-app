import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { interrupt } from "@langchain/langgraph";

export const ASK_LOCATION_TOOL_NAME = "ask_location";

// ask_location is a pure trigger. The tool pauses via interrupt; the
// frontend's addResult resumes with {lat, lon, label} or {error},
// which becomes the ToolMessage content the LLM reads next pass.
// Shape mirrors AskLocationResult in ask-location-card.tsx.
export const askLocationTool = tool(
  async ({ message = "Please pick a location so I can fetch the weather." }) => {
    return interrupt({ ui: ASK_LOCATION_TOOL_NAME, data: {}, message });
  },
  {
    name: ASK_LOCATION_TOOL_NAME,
    description: `Render a location picker card for the user. Use this whenever the user asks about weather without specifying a place. When calling this tool, your text reply must be exactly: "Please pick a location so I can fetch the weather." Do NOT call geocode_location in the same turn. After calling this tool, stop — wait for the user's reply before doing anything else.`,
    schema: z.object({
      message: z.string().describe("The message asking user to provide location"),
    }),
  },
);
