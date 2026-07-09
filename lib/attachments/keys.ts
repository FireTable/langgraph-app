// R2 key construction for chat attachments (issue #12).
// Format: `u/<userId>/<nanoid>-<safe-filename>`.
//
// Key conventions documented at docs/ATTACHMENTS.md; the community pattern
// (Vercel guide / AWS blog) keeps userId bare — R2 list ops require IAM
// regardless of bucket public-read policy, so the leak risk is bounded.

const MAX_NAME_LEN = 200;

export function safeFilename(name: string): string {
  // Strip path components; the filename is the only piece the user controls.
  const base = name.replace(/[/\\]/g, "_").replace(/\.\.+/g, "_");
  // Replace control chars with underscore.
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, "_");
  // Clamp length, then collapse trailing dots (Windows refuses them).
  return cleaned.slice(0, MAX_NAME_LEN).replace(/\.+$/, "") || "file";
}

export function buildKey(userId: string, id: string, name: string): string {
  return `u/${userId}/${id}-${safeFilename(name)}`;
}
