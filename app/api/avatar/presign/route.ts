import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";

import { R2NotConfiguredError, buildPublicUrl, presignPut } from "@/lib/r2/client";
import { safeFilename } from "@/lib/attachments/keys";
import { PresignBody } from "@/lib/attachments/validators";
import { withAuth } from "@/lib/auth/with-auth";

// ponytail: avatars go to R2 under the user's own path, NOT base64 into
// user.image. A base64 data URL there flows through the memory auth-overlay
// (mergeMemory) into every <memory> system block uncapped — issue #28's
// 372K-token blow-up. This route hands back a presigned PUT + the public
// URL; the client stores only the URL. No DB row (avatars aren't chat
// attachments — no dedup / retention sweep needed).

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const ID_LEN = 12;

function generateId(): string {
  const bytes = randomBytes(ID_LEN);
  let out = "";
  for (let i = 0; i < ID_LEN; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

function maxBytes(): number {
  const parsed = process.env.R2_MAX_BYTES ? Number(process.env.R2_MAX_BYTES) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 1024 * 1024;
}

function notConfiguredResponse(): NextResponse {
  return NextResponse.json(
    {
      code: "AVATAR_UPLOADS_NOT_CONFIGURED",
      message: "Set the R2_* env vars to enable avatar uploads (see docs/ATTACHMENTS.md).",
    },
    { status: 503 },
  );
}

export const POST = withAuth(async (req, { user }) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: "BAD_REQUEST", error: "invalid JSON" }, { status: 400 });
  }

  const parsed = PresignBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ code: "BAD_REQUEST", error: parsed.error.issues }, { status: 400 });
  }

  // ponytail: image/* only, and explicitly NOT svg — an SVG can carry
  // inline <script>/<foreignObject>, and with Content-Disposition: inline
  // on a public bucket a leaked URL becomes an XSS page in the bucket
  // origin. (attachments enforces R2_ALLOWED_CONTENT_TYPES, which omits
  // svg by default; we mirror that intent here.)
  const contentType = parsed.data.contentType.toLowerCase();
  if (!contentType.startsWith("image/") || contentType === "image/svg+xml") {
    return NextResponse.json({ code: "CONTENT_TYPE_NOT_ALLOWED", contentType }, { status: 400 });
  }

  const cap = maxBytes();
  if (parsed.data.sizeBytes > cap) {
    return NextResponse.json(
      { code: "FILE_TOO_LARGE", maxBytes: cap, sizeBytes: parsed.data.sizeBytes },
      { status: 400 },
    );
  }

  const key = `u/${user.id}/avatar/${generateId()}-${safeFilename(parsed.data.name)}`;

  let uploadUrl: string;
  try {
    uploadUrl = await presignPut({ key, contentLength: parsed.data.sizeBytes });
  } catch (e) {
    if (e instanceof R2NotConfiguredError) return notConfiguredResponse();
    throw e;
  }

  return NextResponse.json(
    {
      key,
      uploadUrl,
      publicUrl: buildPublicUrl(key),
      uploadHeaders: { "Content-Type": contentType, "Content-Disposition": "inline" },
    },
    { status: 201 },
  );
});
