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
// ratio + optional `num` (1-4) for variants. The result is an array
// of URLs the canvas renders inline via the tool-ui card (see
// components/tool-ui/image/generate-image-card.tsx); the chat model is
// told NOT to echo URLs in its reply because the user already sees the
// generated card.

const FAL_KEY = process.env.FAL_KEY;
const FAL_MODEL = "fal-ai/flux/schnell";
const FAL_BASE = `https://fal.run/${FAL_MODEL}`;

const aspectRatios = ["square", "portrait", "landscape"] as const;

const schema = z.object({
  prompt: z
    .string()
    .describe(
      "What to draw. Be specific: subject, style, lighting, framing. Example: 'a moody flat-lay of a vintage leather journal on a walnut desk, morning light, 35mm'. Required, non-empty.",
    ),
  aspect_ratio: z
    .enum(aspectRatios)
    .default("square")
    .describe("square | portrait | landscape. Default square."),
  num: z
    .number()
    .int()
    .min(1)
    .max(4)
    .default(1)
    .describe(
      "How many variants to generate in one call, 1-4. Default 1. Each variant costs one fal.ai generation; pick >1 only when the user explicitly asks for options.",
    ),
});

type GenerateResult = {
  urls: string[];
  mock: boolean;
  prompt: string;
  aspect_ratio: (typeof aspectRatios)[number];
  num: number;
};

async function impl({ prompt, aspect_ratio, num }: z.infer<typeof schema>): Promise<string> {
  // ponytail: schema requires it, but in practice some reasoning-style
  // models emit an empty first tool_call followed by the real call.
  // LangChain's parser takes the first; if it slips through validation
  // (e.g. via transform()), we want the error message to name the
  // missing field so the LLM can recover on the next turn.
  if (!prompt.trim()) {
    return JSON.stringify({
      success: false,
      error: "missing required field: prompt (non-empty string describing the image to generate)",
    });
  }

  // ponytail: mock-first path. With no key we hand back deterministic
  // placeholders (one per variant, labeled with the index) so the
  // canvas flow end-to-end works on local dev. The `mock: true` flag
  // tells the UI to render a "demo image" badge so users aren't
  // confused about why their prompt became stock photos.
  if (!FAL_KEY) {
    const urls = Array.from({ length: num }, (_, i) => {
      const seed = encodeURIComponent(`${prompt.slice(0, 24)} ${i + 1}`);
      return `https://placehold.co/512x512/png?text=${seed}`;
    });
    return JSON.stringify({
      urls,
      mock: true,
      prompt,
      aspect_ratio,
      num,
    } satisfies GenerateResult);
  }

  const res = await fetch(FAL_BASE, {
    method: "POST",
    headers: {
      Authorization: `Key ${FAL_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt, aspect_ratio, num_images: num }),
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
  const urls = (data.images ?? [])
    .map((img) => img.url)
    .filter((u): u is string => typeof u === "string")
    .slice(0, num);
  if (urls.length === 0) {
    return JSON.stringify({ success: false, error: "fal returned no image url" });
  }

  return JSON.stringify({
    urls,
    mock: false,
    prompt,
    aspect_ratio,
    num: urls.length,
  } satisfies GenerateResult);
}

// ponytail: register unconditionally — mock-first pattern. When
// FAL_KEY is missing, the impl returns placehold.co placeholders so
// the canvas flow works end-to-end on local dev. This is NOT rule
// #10's free-tier exemption (that's fetch_url → r.jina.ai, which
// genuinely serves unauthenticated traffic); fal.ai is paid, we
// just ship a mock so dev doesn't need a key. Prod flips FAL_KEY
// to a real key and the mock branch goes dead.
//
// The tool description explicitly tells the chat model NOT to
// duplicate the image URLs in its reply — the canvas card already
// renders the images inline, so echoing URLs would show them twice.
export const generateImageTool: StructuredTool = tool(impl, {
  name: "generate_image",
  description:
    "Generate one or more fresh images from a text prompt using fal.ai. Use when the user asks to draw, paint, illustrate, or create a new image for the canvas. Args: `prompt` (required), `aspect_ratio` (square/portrait/landscape, default square), `num` (1-4, default 1) for variants. IMPORTANT: this tool already renders the generated images inline in the chat as a card — do NOT describe the images, link the URLs, or list them in your reply; the user sees the generated card automatically. Just call the tool and continue.",
  schema,
});
