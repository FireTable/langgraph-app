// ponytail: shared contract for image-generation backends. Each
// backend (Pollinations, fal.ai, …) is a thin factory that returns
// an `ImageBackend` — the LangGraph tool wraps `pickImageBackend()` and
// doesn't care which one is wired. New backends: implement the
// interface, register them in `index.ts` env selection. Don't bypass
// this file.

export const ASPECT_RATIOS = ["square", "portrait", "landscape"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export interface GenerateArgs {
  prompt: string;
  aspect_ratio: AspectRatio;
  num: number;
  image_url?: string;
}

export interface GenerateResult {
  urls: string[];
  prompt: string;
  aspect_ratio: AspectRatio;
  num: number;
  // ponytail: optional failure message. On success, undefined; on
  // backend error, the upstream status + body so the caller can
  // surface it. Tool layer decides whether to throw or return a
  // structured error to the LLM.
  error?: string;
}

export interface ImageBackend {
  readonly id: "pollinations" | "fal";
  // ponytail: capability flag — only some backends actually honor the
  // `image=` reference for image-to-image. The free Pollinations GET
  // endpoint documents the param but silently drops it on every
  // default model (verified Aug 2026 against flux / gptimage /
  // gptimage-1.5 / klein / turbo — all return the same unconditioned
  // image). The tool impl checks this before calling generate() so we
  // surface a clear "set FAL_KEY / OPENAI_API_KEY to enable img2img"
  // error instead of silently producing a wrong, prompt-only image.
  readonly supportsImageToImage: boolean;
  generate(args: GenerateArgs): Promise<GenerateResult>;
}

// ponytail: aspect → pixel dims. Matches the canvas Preview node's
// stored dims so the rendered card matches the requested aspect.
// Square 512² is the most common request; portrait/landscape are
// 3:4 / 4:3 at the same 512-px edge.
export function dimsFor(aspect: AspectRatio): { w: number; h: number } {
  switch (aspect) {
    case "portrait":
      return { w: 384, h: 512 };
    case "landscape":
      return { w: 512, h: 384 };
    case "square":
    default:
      return { w: 512, h: 512 };
  }
}
