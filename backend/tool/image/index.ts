// ponytail: barrel for image-domain tools. Mirrors the kb/, crypto/,
// code/ folder convention — adding a new image skill = drop a file +
// add one line here. Currently only `generateImageTool` lives here;
// `regenerateImageTool` (existing image + new prompt → variant) and
// `editImageTool` / `upscaleImageTool` etc. follow the same pattern
// (mock-first fallback for dev, real fal.ai when FAL_KEY is set).

export { generateImageTool } from "./generate-image";
