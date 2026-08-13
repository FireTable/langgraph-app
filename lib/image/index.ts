import { createFalBackend } from "./fal";
import { createPollinationsBackend } from "./pollinations";
import type { ImageBackend } from "./types";

export type { AspectRatio, GenerateArgs, GenerateResult, ImageBackend } from "./types";
export { ASPECT_RATIOS, dimsFor } from "./types";

// ponytail: env-driven backend selection. FAL_KEY set → fal (paid,
// opt-in for users who want higher quality); otherwise → Pollinations
// (free, always-available). Both factories return the same
// `ImageBackend` shape; the tool wrapper doesn't care which is wired.
// Adding a new backend: write its factory, add a branch here.

export function pickImageBackend(): ImageBackend {
  const falKey = process.env.FAL_KEY;
  if (falKey) return createFalBackend(falKey);
  return createPollinationsBackend();
}
