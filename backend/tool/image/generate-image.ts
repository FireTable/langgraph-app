import { tool, type StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

import { ASPECT_RATIOS, pickImageBackend } from "@/lib/image";

// ponytail: thin tool wrapper. Generation logic lives in lib/image
// (Pollinations + fal factories); this file is just the zod schema
// the LLM fills in + the LangChain tool() binding. Adding a new
// backend means writing a factory + branch in lib/image/index.ts —
// no change here.

const schema = z.object({
  prompt: z
    .string()
    .describe(
      "What to draw. Be specific: subject, style, lighting, framing. Example: 'a moody flat-lay of a vintage leather journal on a walnut desk, morning light, 35mm'. Required, non-empty.",
    ),
  aspect_ratio: z
    .enum(ASPECT_RATIOS)
    .default("square")
    .describe("square | portrait | landscape. Default square."),
  num: z
    .number()
    .int()
    .min(1)
    .max(4)
    .default(1)
    .describe(
      "How many variants, 1-4. Default 1. Pick >1 only when the user explicitly asks for options.",
    ),
  // ponytail: zod v4 moved string-format helpers (url/email/uuid/...)
  // to top-level fns. `z.url()` is the new form; `.string().url()` is
  // deprecated. The two are semantically identical.
  image_url: z
    .url()
    .optional()
    .describe(
      "Optional reference image URL for image-to-image. Pass the URL of an attached image from the user message. Omit for pure text-to-image.",
    ),
});

async function impl(args: z.infer<typeof schema>): Promise<string> {
  const { prompt, image_url, ...rest } = args;
  if (!prompt.trim()) {
    // ponytail: schema requires it, but reasoning-style models can
    // emit empty first tool_calls. Surface the missing field by name
    // so the LLM can recover on the next turn.
    return JSON.stringify({
      success: false,
      error: "missing required field: prompt (non-empty string describing the image to generate)",
    });
  }

  // ponytail: pickImageBackend() runs on every call so test envs can
  // monkey-patch process.env.FAL_KEY between calls without restart.
  // The factory is cheap (object literal); not worth memoizing.
  const backend = pickImageBackend();
  const result = await backend.generate({ prompt, image_url, ...rest });

  if (result.error) {
    return JSON.stringify({ success: false, error: result.error });
  }
  return JSON.stringify({
    urls: result.urls,
    backend: backend.id,
    prompt: result.prompt,
    aspect_ratio: result.aspect_ratio,
    num: result.num,
  });
}

// ponytail: tool description explicitly tells the chat model NOT to
// duplicate image URLs in its reply — the canvas card renders them
// inline, so echoing URLs would show them twice.
export const generateImageTool: StructuredTool = tool(impl, {
  name: "generate_image",
  description:
    "Generate one or more fresh images from a text prompt. Use when the user asks to draw, paint, illustrate, or create a new image for the canvas. Args: `prompt` (required, non-empty), `aspect_ratio` (square/portrait/landscape, default square), `num` (1-4, default 1) for variants, `image_url` (optional reference image URL for image-to-image). The canvas card already renders the generated images inline — do NOT describe the images, link the URLs, or list them in your reply; the user sees the generated card automatically. Just call the tool and continue.",
  schema,
});
