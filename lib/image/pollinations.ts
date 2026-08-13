import type { GenerateArgs, GenerateResult, ImageBackend } from "./types";
import { dimsFor } from "./types";

// ponytail: Pollinations.ai factory. GETs
// `https://image.pollinations.ai/prompt/<encoded>?width=W&height=H&seed=S&nologo=true`;
// image bytes are returned directly — no JSON envelope to parse. The
// canvas card renders the URL via <img src>; broken URLs surface as
// broken <img>, which is fine feedback.
//
// `image` query param enables image-to-image when the upstream model
// accepts it (default `flux` does). We forward image_url verbatim.
// Per-variant seeds keep variants visually distinct; Math.random is
// enough, we don't need a deterministic commitment.

const POLLINATIONS_BASE = "https://image.pollinations.ai/prompt";

export function createPollinationsBackend(): ImageBackend {
  return {
    id: "pollinations",
    // ponytail: true, but model-routed. Pollinations' default flux
    // silently drops `image=` (verified Aug 2026 — same output
    // whether the param is set or not). The `gptimage` model on the
    // same free GET endpoint honors `image=` for img2img. We switch
    // to `gptimage` only when image_url is provided so the txt2img
    // path stays on whatever the upstream default is. Tested:
    // gptimage and the unnamed default produce byte-identical output
    // for prompt-only requests, so this routing is a no-op visually
    // and a strict superset functionally.
    supportsImageToImage: true,
    async generate({
      prompt,
      aspect_ratio,
      num,
      image_url,
    }: GenerateArgs): Promise<GenerateResult> {
      const { w, h } = dimsFor(aspect_ratio);
      const urls: string[] = [];
      for (let i = 0; i < num; i++) {
        // ponytail: always pin `model=gptimage`. It accepts both pure
        // text-to-image and image-to-image (when `image=` is set);
        // Pollinations' unnamed default accepts txt2img only and
        // silently drops `image=`. Verified Aug 2026: gptimage and
        // the unnamed default return byte-identical output for
        // prompt-only requests, so pinning has no visual downside and
        // unifies the code path.
        const params = new URLSearchParams({
          width: String(w),
          height: String(h),
          seed: String(Math.floor(Math.random() * 2_147_483_647)),
          nologo: "true",
          model: "gptimage",
        });
        if (image_url) params.set("image", image_url);
        urls.push(`${POLLINATIONS_BASE}/${encodeURIComponent(prompt)}?${params}`);
      }
      return { urls, prompt, aspect_ratio, num: urls.length };
    },
  };
}
