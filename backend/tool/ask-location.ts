import { tool } from "@langchain/core/tools";
import { z } from "zod";

// ask_location is a pure trigger. The ToolNode writes a ToolMessage
// with `{ awaiting: "location" }` and the frontend card keys on
// that sentinel to render the picker. The user's pick comes back
// via `addResult` — assistant-ui emits a new ToolMessage with the
// same tool_call_id carrying the resolved payload, and the LLM
// picks it up on its next pass.
export const askLocationTool = tool(
  async () => (JSON.stringify({ awaiting: "location" })),
  {
    name: "ask_location",
    description:
      `Render a location picker card for the user. Use this whenever the user asks about weather without specifying a place. When calling this tool, your text reply must be exactly: "Please pick a location so I can fetch the weather." Do NOT call geocode_location in the same turn. After calling this tool, stop — wait for the user's reply before doing anything else.`,
    schema: z.object({}),
  },
);
