// R2 key construction for chat attachments (issue #12).
//
// Key construction moved to lib/r2/keys.ts factory (r2Keys().upload).
// Chat attachment keys are content-addressed — sha256 of the bytes is
// the key component, so a second upload of the same file collapses to
// one R2 object. The row id in the attachments table is still a 12-char
// random id (used for confirmation routing + DB dedup), but it's no
// longer part of the R2 key.
//
// safeFilename is still exported because the avatar route uses it to
// sanitize the displayed filename sent on the Content-Disposition header
// (no longer embedded in the URL itself).

const MAX_NAME_LEN = 200;

export function safeFilename(name: string): string {
  // Strip path components; the filename is the only piece the user controls.
  const base = name.replace(/[/\\]/g, "_").replace(/\.\.+/g, "_");
  // Replace control chars with underscore.
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, "_");
  // Clamp length, then collapse trailing dots (Windows refuses them).
  return cleaned.slice(0, MAX_NAME_LEN).replace(/\.+$/, "") || "file";
}
