import { tool, type StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

// ponytail: FAL.ai for fresh image generation from a text prompt.
// The tool is text-only — no input image — so the name is
// `generate_image`. A future `regenerate-image` skill (existing image
// + new prompt → variant) will live next to this file as a separate
// tool.
//
// Model: fal-ai/flux/schnell — cheap, fast, no auth handshake beyond
// the key. The schema accepts a free-form prompt + optional aspect
// ratio; canvas clients paste the resulting URL into the canvas via
// the Add-to-canvas button (see components/tool-ui/image/generate-image-card.tsx).

const FAL_KEY = process.env.FAL_KEY;
const FAL_MODEL = "fal-ai/flux/schnell";
const FAL_BASE = `https://fal.run/${FAL_MODEL}`;

const aspectRatios = ["square", "portrait", "landscape"] as const;

const schema = z.object({
  // ponytail: `prompt` accepts missing/empty so the model can recover
  // from a partial first tool_call (some reasoning-style models emit an
  // empty arguments stub before the real call). We re-validate inside
  // `impl` and return a structured error — the LLM then retries with
  // the actual prompt on the next turn. `aspect_ratio` defaults to
  // "square" so the LLM can omit it too.
  prompt: z
    .string()
    .max(2000)
    .default("")
    .describe(
      "What to draw. Be specific: subject, style, lighting, framing. Example: 'a moody flat-lay of a vintage leather journal on a walnut desk, morning light, 35mm'. Required — pass non-empty or the tool returns an error.",
    ),
  aspect_ratio: z
    .enum(aspectRatios)
    .default("square")
    .describe("square | portrait | landscape. Default square."),
});

type GenerateResult = {
  url: string;
  mock: boolean;
  prompt: string;
  aspect_ratio: (typeof aspectRatios)[number];
};

async function impl({ prompt, aspect_ratio }: z.infer<typeof schema>): Promise<string> {
  // ponytail: gate on empty prompt. Returning a structured error (vs
  // throwing) keeps the tool call inside the LLM's reasoning loop —
  // it can see "missing prompt" and re-emit a complete tool_call next
  // turn. Throwing would bubble up as a hard failure and abort the run.
  if (!prompt.trim()) {
    return JSON.stringify({
      success: false,
      error: "missing required field: prompt (non-empty string describing the image to generate)",
    });
  }

  // ponytail: mock-first path. With no key we hand back a deterministic
  // placeholder so the canvas flow end-to-end works on local dev. The
  // `mock: true` flag tells the UI to render a "demo image" badge so
  // users aren't confused about why their prompt became a stock photo.
  if (!FAL_KEY) {
    const seed = encodeURIComponent(prompt.slice(0, 32));
    return JSON.stringify({
      url: `https://placehold.co/512x512/png?text=${seed}`,
      mock: true,
      prompt,
      aspect_ratio,
    } satisfies GenerateResult);
  }

  const res = await fetch(FAL_BASE, {
    method: "POST",
    headers: {
      Authorization: `Key ${FAL_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt, aspect_ratio }),
  });

  if (!res.ok) {
    // ponytail: surface upstream status + body so the chat model can
    // decide whether to retry / rephrase / fall back. Returning a
    // structured error (vs throwing) keeps the tool call inside the
    // LLM's reasoning loop.
    const body = await res.text().catch(() => "");
    return JSON.stringify({
      success: false,
      error: `fal ${res.status}: ${body.slice(0, 500)}`,
    });
  }

  const data = (await res.json()) as { images?: Array<{ url?: string }> };
  const url = data.images?.[0]?.url;
  if (!url) {
    return JSON.stringify({ success: false, error: "fal returned no image url" });
  }

  return JSON.stringify({
    url,
    mock: false,
    prompt,
    aspect_ratio,
  } satisfies GenerateResult);
}

// ponytail: register unconditionally — mock-first pattern. When
// FAL_KEY is missing, the impl returns a placehold.co placeholder
// so the canvas flow works end-to-end on local dev. This is NOT
// rule #10's free-tier exemption (that's fetch_url → r.jina.ai,
// which genuinely serves unauthenticated traffic); fal.ai is paid,
// we just ship a mock so dev doesn't need a key. Prod flips FAL_KEY
// to a real key and the mock branch goes dead.
export const generateImageTool: StructuredTool = tool(impl, {
  name: "generate_image",
  description:
    "Generate a brand-new image from a text prompt using fal.ai. Use when the user asks to draw, paint, illustrate, or create a fresh image for the canvas. Takes a prompt and optional aspect ratio; returns a URL the canvas can paste in.",
  schema,
});
