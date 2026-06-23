import { tool } from "@langchain/core/tools";
import { z } from "zod";

// ask_location is a UI-only marker: the frontend renders the location
// picker card and writes the coords back via the tool's result. The
// backend's execute is intentionally trivial — anything the model needs
// to react to comes through the frontend-supplied result.
export const askLocationTool = tool(
  async () => ({
    status: "awaiting_user_location",
  }),
  {
    name: "ask_location",
    description:
      "Render a location picker card for the user. Use this whenever the user asks about weather without specifying a place. Do NOT call geocode_location in the same turn.",
    schema: z.object({}),
  },
);
