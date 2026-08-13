import type { GenerateArgs, GenerateResult, ImageBackend } from "./types";

// ponytail: fal.ai factory. POSTs JSON to
// `https://fal.run/fal-ai/flux/schnell`, parses `{ images: [{ url }] }`.
// `num_images` is fal's field name (vs. our `num`); image_url maps
// directly to fal's `image_url` body key for img2img.

const FAL_BASE = "https://fal.run/fal-ai/flux/schnell";

export function createFalBackend(apiKey: string): ImageBackend {
  return {
    id: "fal",
    // ponytail: true. fal's flux-schnell model accepts the
    // `image_url` body key for image-to-image. The tool layer
    // forwards image_url verbatim.
    supportsImageToImage: true,
    async generate({
      prompt,
      aspect_ratio,
      num,
      image_url,
    }: GenerateArgs): Promise<GenerateResult> {
      const res = await fetch(FAL_BASE, {
        method: "POST",
        headers: {
          Authorization: `Key ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt,
          aspect_ratio,
          num_images: num,
          ...(image_url ? { image_url } : {}),
        }),
      });

      if (!res.ok) {
        // ponytail: surface upstream status + body so the chat model
        // can decide whether to retry / rephrase / fall back. A
        // structured error keeps the tool call inside the LLM's
        // reasoning loop (vs throwing).
        const body = await res.text().catch(() => "");
        return {
          urls: [],
          prompt,
          aspect_ratio,
          num: 0,
          error: `fal ${res.status}: ${body.slice(0, 500)}`,
        };
      }

      const data = (await res.json()) as { images?: Array<{ url?: string }> };
      const urls = (data.images ?? [])
        .map((img) => img.url)
        .filter((u): u is string => typeof u === "string")
        .slice(0, num);
      if (urls.length === 0) {
        return { urls: [], prompt, aspect_ratio, num: 0, error: "fal returned no image url" };
      }
      return { urls, prompt, aspect_ratio, num: urls.length };
    },
  };
}
