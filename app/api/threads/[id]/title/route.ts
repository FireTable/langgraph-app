import "server-only";
import { GenerateTitleBody } from "@/lib/threads/validators";
import { renameThread } from "@/lib/threads/queries";

// POST /api/threads/[id]/title — generate a short title for the thread
// using the first user message. assistant-ui streams the result via
// adapter.generateTitle(), so we return an assistant-stream compatible
// response AND persist the title to the threads row so the sidebar
// picks it up on the next list() call.
//
// For now we just use the first user message's text. A future iteration
// can call the LLM here, but a deterministic placeholder is enough for
// the adapter to wire up.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const json = await req.json().catch(() => null);
  const parsed = GenerateTitleBody.safeParse(json);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: parsed.error.issues }), { status: 400 });
  }
  const firstUser = parsed.data.messages.find((m) => m.role === "user");
  const title = firstUser?.content[0]?.text ?? "New Chat";
  await renameThread(id, title);
  // Stream a single chunk via ReadableStream so assistant-ui's
  // generateTitle() consumes it like a real model response.
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(title));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  });
}
