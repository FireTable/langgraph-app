import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { interrupt } from "@langchain/langgraph";

// ask_location pauses the graph for human input. The tool's first call
// throws an interrupt; the frontend's AskLocationCard collects a pick
// and re-invokes the run with `Command({ resume: <json-string> })`.
// On the resumed call, `interrupt()` returns that string and we parse
// it as the tool's result — the ToolNode then writes a single
// ToolMessage so the next model turn has the coords to react to.
//
// Payload shape mirrors AskLocationResult on the frontend:
//   { lat, lon, label } — user picked coords
//   { error }           — geolocation denied or geocode failed
const ResumeSchema = z.union([
  z.object({ lat: z.number(), lon: z.number(), label: z.string() }),
  z.object({ error: z.string() }),
]);

export const askLocationTool = tool(
  // ponytail: the function body runs once per tool invocation. The
  // first time it throws GraphInterrupt; on resume LangGraph replays
  // the call and `interrupt()` returns the resume value instead.
  async () => {
    const raw = interrupt({ awaiting: "location" });
    // useLangGraphSendCommand types `resume` as `string`; let test
    // callers pass a structured value directly to skip the round-trip.
    const candidate = typeof raw === "string" ? parseOrFail(raw) : raw;
    const parsed = ResumeSchema.safeParse(candidate);
    if (!parsed.success) {
      return { error: "Invalid location payload" };
    }
    return parsed.data;
  },
  {
    name: "ask_location",
    description:
      "Render a location picker card for the user. Use this whenever the user asks about weather without specifying a place. Do NOT call geocode_location in the same turn.",
    schema: z.object({}),
  },
);

// `null` makes zod's safeParse fail and the tool returns
// `{ error: "Invalid location payload" }` to the model.
function parseOrFail(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
